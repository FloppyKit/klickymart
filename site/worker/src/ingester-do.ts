/** RelayIngester Durable Object: keeps live WebSocket subscriptions to RELAY_URLS with exponential backoff, buffers
 * events and flushes them to D1. An alarm every 30 s re-establishes dropped sockets and flushes; the 5-minute cron
 * runs a separate `since`-based catch-up so nothing is lost while a socket is down. */
import { buildFilters, ingestEvents, parseFrame, relayList, saveState, workerConnect, type IngestCtx, type SocketLike } from "./relay-ingest";
import { loadSnapshot, type Env } from "./router";
import { crawlerPubkeyHexFromSnapshot } from "./crawler-pubkey";

const ALARM_MS = 30_000;
const FLUSH_AT = 50;

export async function ingestCtx(env: Env): Promise<IngestCtx> {
  const snap = await loadSnapshot(env);
  return { domains: new Set(snap.rows.map((r) => r.d)), ourPubkey: crawlerPubkeyHexFromSnapshot(snap, env.CRAWLER_PUBKEY_HEX) };
}

interface RelayLive { ws: SocketLike | null; state: "connecting" | "open" | "down"; attempts: number; nextTry: number; since: number; opened_at: number | null; events: number; last_error: string | null }

export class RelayIngester {
  private live = new Map<string, RelayLive>();
  private buffer: { ev: unknown; relay: string }[] = [];
  private flushing: Promise<void> | null = null;

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(_req: Request): Promise<Response> {
    await this.ensure();
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + ALARM_MS);
    return Response.json(this.status());
  }

  async alarm(): Promise<void> {
    try { await this.ensure(); await this.flush(); } finally { await this.state.storage.setAlarm(Date.now() + ALARM_MS); }
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
            r.events++; this.buffer.push({ ev: f.ev, relay: url });
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
    this.flushing = (async () => {
      const ctx = await ingestCtx(this.env);
      const byRelay = new Map<string, typeof batch>();
      for (const b of batch) byRelay.set(b.relay, [...(byRelay.get(b.relay) ?? []), b]);
      for (const [relay, items] of byRelay) {
        const r = await ingestEvents(this.env.DB, items, ctx);
        await saveState(this.env.DB, relay, { maxCreated: r.maxCreated, events: r.accepted + r.duplicate, rejected: r.rejected, ok: true });
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
