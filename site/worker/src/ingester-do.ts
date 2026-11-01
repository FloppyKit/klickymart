import { buildFlagStatic } from "./flags";
import { SELFTEST_DOMAIN } from "./experience";
/** RelayIngester Durable Object: keeps live WebSocket subscriptions to RELAY_URLS with exponential backoff, buffers
 * events and flushes them to D1. No DO alarm is ever armed (no self-re-arming loop); the daily cron (15 6 * * *)
 * runs a separate `since`-based catch-up so nothing is lost while a socket is down. */
import { BUFFER_LIMITS, buildFilters, ingestEvents, parseFrame, relayList, saveState, workerConnect, type IngestCtx, type SocketLike } from "./relay-ingest";
import { loadSnapshot, type Env } from "./router";
import { crawlerPubkeyHexFromSnapshot } from "./crawler-pubkey";

const FLUSH_AT = 50;

export async function ingestCtx(env: Env): Promise<IngestCtx> {
  const snap = await loadSnapshot(env);
  const status = new Map(snap.rows.map((r) => [r.d, r.status]));
  return { domains: new Set([...snap.rows.map((r) => r.d), SELFTEST_DOMAIN]), ourPubkey: crawlerPubkeyHexFromSnapshot(snap, env.CRAWLER_PUBKEY_HEX),
    flagStatic: await buildFlagStatic(snap), indexStatus: (d: string) => status.get(d) };
}

interface RelayLive { ws: SocketLike | null; state: "connecting" | "open" | "down"; attempts: number; nextTry: number; since: number; opened_at: number | null; events: number; last_error: string | null }

/** Live WebSocket ingest is opt-in (LIVE_INGEST="1"/"true"); off by default so the DO is never kept awake. The daily cron catch-up covers ingest. */
export function liveIngestEnabled(env: { LIVE_INGEST?: string }): boolean {
  return env.LIVE_INGEST === "1" || env.LIVE_INGEST === "true";
}

export class RelayIngester {
  private live = new Map<string, RelayLive>();
  private buffer: { ev: unknown; relay: string; bytes: number }[] = [];
  private bufferBytes = 0;
  private flushing: Promise<void> | null = null;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(_req: Request): Promise<Response> {
    if (!liveIngestEnabled(this.env as { LIVE_INGEST?: string })) { await this.shutdown(); return Response.json({ disabled: true }); }
    await this.ensure();
    return Response.json(this.status());
  }

  /** Legacy alarm (armed by older deploys): flush once, drop it, never re-arm. */
  async alarm(): Promise<void> {
    if (!liveIngestEnabled(this.env as { LIVE_INGEST?: string })) { await this.shutdown(); return; }
    try { await this.flush(); } finally { await this.state.storage.deleteAlarm(); }
  }

  /** LIVE_INGEST off: close sockets, drop the alarm, do not re-arm. */
  private async shutdown(): Promise<void> {
    for (const r of this.live.values()) { const ws = r.ws; r.ws = null; r.state = "down"; try { ws?.close(1000, "live ingest disabled"); } catch { /* */ } }
    this.live.clear();
    try { await this.flush(); } catch { /* catch-up recovers */ }
    await this.state.storage.deleteAlarm();
  }

  status() {
    const now = Date.now();
    return Object.fromEntries([...this.live.entries()].map(([url, r]) => [url, { state: r.state, attempts: r.attempts, next_retry_in_s: r.state === "down" ? Math.max(0, Math.round((r.nextTry - now) / 1000)) : 0, opened_at: r.opened_at, events_this_session: r.events, last_error: r.last_error }]));
  }

  private async ensure(): Promise<void> {
    const relays = relayList(this.env.RELAY_URLS);
    const ctx = await ingestCtx(this.env);
    const now = Date.now();
    await Promise.all(relays.map(async (url) => {
      const r = this.live.get(url) ?? { ws: null, state: "down" as const, attempts: 0, nextTry: 0, since: Math.floor(now / 1000) - 600, opened_at: null, events: 0, last_error: null };
      this.live.set(url, r);
      if (r.state !== "down" || now < r.nextTry) return;
      r.state = "connecting";
      try {
        const ws = await workerConnect(url);
        r.ws = ws; r.state = "open"; r.opened_at = Math.floor(Date.now() / 1000); r.last_error = null;
        ws.addEventListener("message", (e) => {
          const f = parseFrame(e.data);
          if (f?.type === "EVENT") {
            // KIMI-008: bounded buffer. When full, close this relay (backpressure) and let the since-based catch-up recover.
            const bytes = String(e.data).length;
            if (this.buffer.length >= BUFFER_LIMITS.liveMaxEvents || this.bufferBytes + bytes > BUFFER_LIMITS.liveMaxBytes) {
              try { ws.close(1013, "try again later"); } catch { /* */ }
              down("buffer full: closed for backpressure"); return;
            }
            r.events++; this.buffer.push({ ev: f.ev, relay: url, bytes }); this.bufferBytes += bytes;
            if (this.buffer.length >= FLUSH_AT) void this.flush();
          } else if (f?.type === "EOSE") { r.attempts = 0; }
          else if (f?.type === "CLOSED") r.last_error = `CLOSED: ${f.msg ?? ""}`;
        });
        const down = (why: string) => {
          if (r.ws !== ws) return;
          r.ws = null; r.state = "down"; r.attempts++; r.last_error = why;
          r.nextTry = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(6, r.attempts));
          r.since = Math.floor(Date.now() / 1000) - 120;
          void saveState(this.env.DB, url, { error: why });
        };
        ws.addEventListener("close", () => down("socket closed"));
        ws.addEventListener("error", () => down("socket error"));
        buildFilters(ctx, r.since).forEach((f, i) => ws.send(JSON.stringify(["REQ", `km-live-${i}`, f])));
        await saveState(this.env.DB, url, { ok: true });
      } catch (e) {
        r.ws = null; r.state = "down"; r.attempts++; r.last_error = (e as Error).message.slice(0, 200);
        r.nextTry = Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(6, r.attempts));
        await saveState(this.env.DB, url, { error: `live connect failed: ${r.last_error}` });
      }
    }));
  }

  private async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const batch = this.buffer.splice(0);
    if (!batch.length) return;
    this.bufferBytes -= batch.reduce((a, b) => a + b.bytes, 0);
    this.flushing = (async () => {
      const ctx = await ingestCtx(this.env);
      const byRelay = new Map<string, typeof batch>();
      for (const b of batch) byRelay.set(b.relay, [...(byRelay.get(b.relay) ?? []), b]);
      for (const [relay, items] of byRelay) {
        try {
          const r = await ingestEvents(this.env.DB, items, ctx);
          await saveState(this.env.DB, relay, { maxCreated: r.maxCreated, events: r.accepted + r.duplicate, rejected: r.rejected, ok: true });
        } catch (e) {
          // KIMI-008: a failed D1 write is not silently dropped: requeue within the buffer bounds, else rely on catch-up.
          const room = BUFFER_LIMITS.liveMaxEvents - this.buffer.length;
          if (room > 0) { const back = items.slice(0, room); this.buffer.unshift(...back); this.bufferBytes += back.reduce((a, b) => a + b.bytes, 0); }
          try { await saveState(this.env.DB, relay, { error: `flush failed: ${(e as Error).message}`.slice(0, 200) }); } catch { /* */ }
        }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
