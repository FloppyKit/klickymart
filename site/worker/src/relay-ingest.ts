import { markFacilitatedHistory } from "./facilitate";
/** Relay ingest core: filters, validation, storage, proof checks, catch-up. Transport-agnostic (socket injected). */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { NOSTR_KIND_ACCEPTANCE, NOSTR_KIND_CRAWL_RECORD, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_NEED } from "./nostr-kinds";
import type { NostrEventLine } from "./nostr-record-source";
import { verifyNostrEvent } from "./nostr-verify";
import { parseReviewEvent, storeReview } from "./reviews";
import { KIND_NOTE, NOTE_HASHTAG, parseExperience, storeExperience } from "./experience";
import { decodeBolt11 } from "./bolt11";

export const ZAP_RECEIPT_KIND = 9735;
export const DELETION_KIND = 5;
export const INGEST_LIMITS = { perPubkeyPerDay: 200, maxEventBytes: 65536, catchupTimeoutMs: 12_000, catchupOverlapS: 120 };

export interface IngestCtx {
  domains: Set<string>;
  ourPubkey: string | null;
  now?: number;
}

export type Ev = Required<Pick<NostrEventLine, "id" | "pubkey" | "sig" | "kind" | "created_at" | "tags" | "content">>;

export function relayList(raw: string | undefined): string[] {
  return (raw ?? "").replace(/[\\[\\]"]/g, "").split(",").map((x) => x.trim()).filter((x) => /^wss?:\/\//.test(x));
}

/** REQ filters for one relay. */
export function buildFilters(ctx: IngestCtx, since: number, fulfillmentIds: string[] = []): Record<string, unknown>[] {
  const domains = [...ctx.domains].sort();
  const f: Record<string, unknown>[] = [
    { kinds: [NOSTR_KIND_CRAWL_RECORD], since },
    { kinds: [NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE], "#r": domains, since },
  ];
  if (ctx.ourPubkey) f.push({ kinds: [NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE], "#a": domains.map((d) => `${NOSTR_KIND_CRAWL_RECORD}:${ctx.ourPubkey}:${d}`), since });
  // Zap receipts on known 421s (payment proof) and on known 422/kind-1 notes (tips; see tips.ts).
  if (fulfillmentIds.length) f.push({ kinds: [ZAP_RECEIPT_KIND], "#e": fulfillmentIds.slice(0, 400) });
  // NIP-09 deletions of anything we store (by id) and of notes tagged for us (k tags); applied only when the author matches.
  if (fulfillmentIds.length) f.push({ kinds: [DELETION_KIND], "#e": fulfillmentIds.slice(0, 400) });
  f.push({ kinds: [DELETION_KIND], "#k": [String(NOSTR_KIND_ACCEPTANCE), String(NOSTR_KIND_FULFILLMENT), String(NOSTR_KIND_NEED), String(KIND_NOTE)], since });
  // Shopping experiences: structured 422s tagged #klickymart (any store) and unstructured kind-1 notes tagged #klickymart.
  f.push({ kinds: [NOSTR_KIND_ACCEPTANCE, KIND_NOTE], "#t": [NOTE_HASHTAG], since });
  return f;
}

const tagv = (tags: string[][], n: string) => tags.find((t) => t[0] === n)?.[1];

/** Which merchant domain an event concerns (a-tag 31420:*:<d> first, then r, then d for 31420). */
export function eventDomain(ev: Ev, ctx: IngestCtx): string | null {
  if (ev.kind === NOSTR_KIND_CRAWL_RECORD) {
    const d = tagv(ev.tags, "d")?.toLowerCase();
    return d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
  }
  for (const t of ev.tags) {
    if (t[0] === "a") {
      const m = t[1]?.match(new RegExp(`^${NOSTR_KIND_CRAWL_RECORD}:[0-9a-f]{64}:([a-z0-9.-]+)$`));
      if (m && ctx.domains.has(m[1]!)) return m[1]!;
    }
  }
  const r = tagv(ev.tags, "r")?.toLowerCase();
  return r && ctx.domains.has(r) ? r : null;
}

export type Verdict = { ok: true; d: string | null } | { ok: false; reason: string };

/** Signature + schema check for every relay event. */
export function validateRelayEvent(input: unknown, ctx: IngestCtx): Verdict {
  if (!input || typeof input !== "object") return { ok: false, reason: "not an object" };
  const ev = input as Ev;
  if (JSON.stringify(ev).length > INGEST_LIMITS.maxEventBytes) return { ok: false, reason: "too large" };
  if (![NOSTR_KIND_CRAWL_RECORD, NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE, ZAP_RECEIPT_KIND, KIND_NOTE, DELETION_KIND].includes(ev.kind)) return { ok: false, reason: "kind not followed" };
  if (ev.kind === KIND_NOTE) {
    const x = parseExperience(ev, (dd) => ctx.domains.has(dd), ctx.now ?? Date.now(), { maxAgeS: 10 * 365 * 86400 });
    return x.ok ? { ok: true, d: x.value.d } : { ok: false, reason: `note: ${x.message}` };
  }
  const v = verifyNostrEvent(ev, ev.kind);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return { ok: false, reason: "bad tags" };
  if (ev.created_at > Math.floor((ctx.now ?? Date.now()) / 1000) + 600) return { ok: false, reason: "future created_at" };
  if (ev.kind === ZAP_RECEIPT_KIND) return { ok: true, d: null };
  if (ev.kind === DELETION_KIND) return ev.tags.some((t) => t[0] === "e" && /^[0-9a-f]{64}$/.test(t[1] ?? "")) ? { ok: true, d: null } : { ok: false, reason: "deletion without e tags" };
  const d = eventDomain(ev, ctx);
  if (ev.kind === NOSTR_KIND_CRAWL_RECORD) {
    if (!d) return { ok: false, reason: "31420 without valid d tag" };
    try { JSON.parse(ev.content); } catch { return { ok: false, reason: "31420 content is not JSON" }; }
    return { ok: true, d };
  }
  if (!d) return { ok: false, reason: "does not reference an indexed merchant (a 31420:*:<domain> or r tag)" };
  if (ev.kind === NOSTR_KIND_ACCEPTANCE && tagv(ev.tags, "rating") !== undefined) {
    const r = parseReviewEvent(ev, (x) => ctx.domains.has(x), ctx.now ?? Date.now(), { maxAgeS: 10 * 365 * 86400 });
    const x = r.ok ? null : parseExperience(ev, (dd) => ctx.domains.has(dd), ctx.now ?? Date.now(), { maxAgeS: 10 * 365 * 86400 });
    if (!r.ok && !x?.ok) return { ok: false, reason: `review: ${r.message}` };
  }
  return { ok: true, d };
}

/** Cheap proof checks. preimage: sha256(preimage) == payment_hash of the 421's bolt11.
 * zap: receipt is a valid signed 9735 that references the 421 and carries a bolt11 with an amount (receipt signer is
 * not yet checked against the recipient's LNURL nostrPubkey). */
export function checkProof(review: Ev, fulfillment: Ev | null, zapReceipt: Ev | null): "verified-preimage" | "verified-zap" | "unverified-claim" | null {
  const ful = review.tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1];
  const pre = tagv(review.tags, "preimage"); const zap = tagv(review.tags, "zap"); const cashu = tagv(review.tags, "cashu");
  if (!ful && !pre && !zap && !cashu) return null;
  if (!ful || !fulfillment || fulfillment.id !== ful || fulfillment.kind !== NOSTR_KIND_FULFILLMENT) return "unverified-claim";
  if (pre && /^[0-9a-f]{64}$/i.test(pre)) {
    const inv = tagv(fulfillment.tags, "bolt11"); const dec = inv ? decodeBolt11(inv) : null;
    if (dec && bytesToHex(sha256(hexToBytes(pre.toLowerCase()))) === dec.payment_hash) return "verified-preimage";
  }
  if (zap && zapReceipt && zapReceipt.id === zap && zapReceipt.kind === ZAP_RECEIPT_KIND && verifyNostrEvent(zapReceipt, ZAP_RECEIPT_KIND).ok) {
    const refs = zapReceipt.tags.some((t) => t[0] === "e" && t[1] === ful);
    const b = tagv(zapReceipt.tags, "bolt11"); const dec = b ? decodeBolt11(b) : null;
    if (refs && dec && (dec.amount_msat ?? 0) > 0) return "verified-zap";
  }
  return "unverified-claim";
}

export interface IngestResult { accepted: number; duplicate: number; rejected: number; reasons: Record<string, number>; maxCreated: number }

async function getEvent(db: D1Database, id: string | undefined): Promise<Ev | null> {
  if (!id) return null;
  const r = await db.prepare("SELECT raw_json FROM nostr_events WHERE id = ?").bind(id).first<{ raw_json: string }>();
  return r ? (JSON.parse(r.raw_json) as Ev) : null;
}

/** NIP-09: for each e-tagged id, delete our stored copy (event, review, note, record) only when the deletion's pubkey is the
 * event's author, and keep a tombstone (id + author) so later catch-ups cannot re-ingest it. Ids we have not seen yet get a
 * tombstone bound to the deleter's pubkey, which only blocks events by that same pubkey. Tips on a deleted note disappear
 * with it (tips are read only for stored notes) and aggregates are computed on read, so they update immediately. */
export async function applyDeletion(db: D1Database, del: Ev, nowS: number): Promise<{ deleted: string[]; ignored: string[] }> {
  const out = { deleted: [] as string[], ignored: [] as string[] };
  for (const id of [...new Set(del.tags.filter((t) => t[0] === "e" && /^[0-9a-f]{64}$/.test(t[1] ?? "")).map((t) => t[1]!))].slice(0, 100)) {
    const row = await db.prepare("SELECT pubkey FROM nostr_events WHERE id = ?").bind(id).first<{ pubkey: string }>();
    let author = row?.pubkey;
    if (!author) { try { author = (await db.prepare("SELECT pubkey FROM experiences WHERE id = ? UNION SELECT pubkey FROM reviews WHERE id = ?").bind(id, id).first<{ pubkey: string }>())?.pubkey; } catch { /* */ } }
    if (author && author !== del.pubkey) { out.ignored.push(id); continue; }
    const stmts = [db.prepare("DELETE FROM nostr_events WHERE id = ?").bind(id), db.prepare("DELETE FROM reviews WHERE id = ?").bind(id),
      db.prepare("DELETE FROM site_records WHERE id = ?").bind(id), db.prepare("DELETE FROM experiences WHERE id = ?").bind(id),
      db.prepare("INSERT OR IGNORE INTO tombstones (id, pubkey, deletion_id, deleted_at) VALUES (?,?,?,?)").bind(id, del.pubkey, del.id, nowS)];
    try { await db.batch(stmts); } catch { await db.batch(stmts.slice(0, 3)); }
    out.deleted.push(id);
  }
  return out;
}

/** Store a batch of events seen on a relay. Dedupe by id (adds the relay to the event's relay list).
 * Query-light: one lookup for existing ids, one for pubkey counts, then a single D1 batch (D1 per-invocation query limits). */
export async function ingestEvents(db: D1Database, batch: { ev: unknown; relay: string }[], ctx: IngestCtx): Promise<IngestResult> {
  const res: IngestResult = { accepted: 0, duplicate: 0, rejected: 0, reasons: {}, maxCreated: 0 };
  const now = ctx.now ?? Date.now();
  const nowS = Math.floor(now / 1000);
  const reject = (why: string) => { res.rejected++; const k = why.split(":")[0]!; res.reasons[k] = (res.reasons[k] ?? 0) + 1; };
  const valid: { ev: Ev; relay: string; d: string | null }[] = [];
  const exps: Ev[] = [];
  for (const { ev: raw, relay } of batch) {
    const v = validateRelayEvent(raw, ctx);
    if (!v.ok) { reject(v.reason); continue; }
    valid.push({ ev: raw as Ev, relay, d: v.d });
    res.maxCreated = Math.max(res.maxCreated, (raw as Ev).created_at);
  }
  const dels = valid.filter((x) => x.ev.kind === DELETION_KIND);
  if (dels.length) {
    for (const { ev } of dels) { await applyDeletion(db, ev, nowS); res.accepted++; }
    for (let k = valid.length - 1; k >= 0; k--) if (valid[k]!.ev.kind === DELETION_KIND) valid.splice(k, 1);
  }
  if (valid.length) {
    const ids0 = [...new Set(valid.map((x) => x.ev.id))];
    const tomb = new Map<string, string>();
    for (let k = 0; k < ids0.length; k += 90) {
      const chunk = ids0.slice(k, k + 90);
      try {
        const { results } = await db.prepare(`SELECT id, pubkey FROM tombstones WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ id: string; pubkey: string }>();
        for (const r of results ?? []) tomb.set(r.id, r.pubkey);
      } catch { /* migration pending */ }
    }
    for (let k = valid.length - 1; k >= 0; k--) if (tomb.get(valid[k]!.ev.id) === valid[k]!.ev.pubkey) { valid.splice(k, 1); reject("deleted by author (tombstone)"); }
  }
  if (!valid.length) return res;
  const existing = new Map<string, string>();
  const ids = [...new Set(valid.map((x) => x.ev.id))];
  for (let k = 0; k < ids.length; k += 90) {
    const chunk = ids.slice(k, k + 90);
    const { results } = await db.prepare(`SELECT id, relays FROM nostr_events WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ id: string; relays: string }>();
    for (const r of results ?? []) existing.set(r.id, r.relays);
  }
  const pks = [...new Set(valid.map((x) => x.ev.pubkey).filter((p) => p !== ctx.ourPubkey))];
  const pkCount = new Map<string, number>();
  for (let k = 0; k < pks.length; k += 90) {
    const chunk = pks.slice(k, k + 90);
    const { results } = await db.prepare(`SELECT pubkey, COUNT(*) AS n FROM nostr_events WHERE first_seen > ? AND pubkey IN (${chunk.map(() => "?").join(",")}) GROUP BY pubkey`).bind(nowS - 86400, ...chunk).all<{ pubkey: string; n: number }>();
    for (const r of results ?? []) pkCount.set(r.pubkey, r.n);
  }
  const stmts: D1PreparedStatement[] = [];
  const reviews: Ev[] = [];
  for (const { ev, relay, d } of valid) {
    const prev = existing.get(ev.id);
    if (prev !== undefined) {
      if (!prev.split(",").includes(relay)) {
        const rel = prev + "," + relay;
        existing.set(ev.id, rel);
        stmts.push(db.prepare("UPDATE nostr_events SET relays = ? WHERE id = ?").bind(rel, ev.id),
          db.prepare("UPDATE site_records SET relays = ? WHERE id = ?").bind(rel, ev.id),
          db.prepare("UPDATE reviews SET relays = ? WHERE id = ?").bind(rel, ev.id));
      }
      res.duplicate++; continue;
    }
    if (ev.pubkey !== ctx.ourPubkey && ev.kind !== ZAP_RECEIPT_KIND) { // receipts are signed by LNURL servers on behalf of many payers
      const n = pkCount.get(ev.pubkey) ?? 0;
      if (n >= INGEST_LIMITS.perPubkeyPerDay) { reject("rate-limited pubkey"); continue; }
      pkCount.set(ev.pubkey, n + 1);
    }
    existing.set(ev.id, relay);
    stmts.push(db.prepare("INSERT OR IGNORE INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)")
      .bind(ev.id, ev.kind, ev.pubkey, ev.created_at, d, JSON.stringify(ev), nowS, relay));
    if (ev.kind === NOSTR_KIND_CRAWL_RECORD) {
      stmts.push(db.prepare(`INSERT INTO site_records (pubkey,d,id,created_at,raw_json,relays) VALUES (?,?,?,?,?,?)
        ON CONFLICT(pubkey,d) DO UPDATE SET id=excluded.id, created_at=excluded.created_at, raw_json=excluded.raw_json, relays=excluded.relays
        WHERE excluded.created_at > site_records.created_at OR (excluded.created_at = site_records.created_at AND excluded.id < site_records.id)`)
        .bind(ev.pubkey, d, ev.id, ev.created_at, JSON.stringify(ev), relay));
    }
    if (ev.kind === NOSTR_KIND_ACCEPTANCE && tagv(ev.tags, "rating") !== undefined) reviews.push(ev);
    if (ev.kind === NOSTR_KIND_ACCEPTANCE || ev.kind === KIND_NOTE) exps.push(ev);
    res.accepted++;
  }
  for (let k = 0; k < stmts.length; k += 200) await db.batch(stmts.slice(k, k + 200));
  for (const ev of exps) {
    const x = parseExperience(ev, (dd) => ctx.domains.has(dd), now, { maxAgeS: 10 * 365 * 86400 });
    if (!x.ok) continue;
    let ps: string | null = null;
    if (ev.kind === NOSTR_KIND_ACCEPTANCE && x.value.proof) { try { ps = checkProof(ev, await getEvent(db, ev.tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1]), await getEvent(db, tagv(ev.tags, "zap"))); } catch { ps = null; } }
    try { await storeExperience(db, x.value, ev, { source: "relay", relays: existing.get(ev.id) ?? null, proof_status: ps ?? (x.value.proof ? "proof-attached" : null) }, now); } catch { /* migration pending */ }
  }
  for (const ev of reviews) {
    const p = parseReviewEvent(ev, (x) => ctx.domains.has(x), now, { maxAgeS: 10 * 365 * 86400 });
    if (!p.ok) continue;
    const ful = await getEvent(db, p.value.fulfillment ?? undefined);
    const zap = await getEvent(db, tagv(ev.tags, "zap"));
    await storeReview(db, p.value, ev, now, { source: "relay", relays: existing.get(ev.id) ?? null, proof_status: checkProof(ev, ful, zap) });
  }
  const touched = new Set([...reviews, ...exps, ...valid.filter((x) => x.ev.kind === NOSTR_KIND_FULFILLMENT).map((x) => x.ev)].map((e) => eventDomain(e, ctx) ?? tagv(e.tags, "r")).filter((x): x is string => !!x));
  for (const d of touched) await markFacilitatedHistory(db, d);
  return res;
}

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", fn: (e: { data?: unknown }) => void): void;
}
export type Connect = (url: string) => Promise<SocketLike>;

/** Outbound WebSocket from a Worker / Durable Object (wss:// -> https:// upgrade). */
export const workerConnect: Connect = async (url) => {
  const resp = await fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket", "User-Agent": "KlickyMartIngest/1.0 (+https://klickymart.com/bot; bot@klickymart.com)" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`no websocket (HTTP ${resp.status})`);
  ws.accept();
  return ws as unknown as SocketLike;
};

/** Parse one relay frame into an event (or null). */
export function parseFrame(data: unknown): { type: "EVENT"; sub: string; ev: unknown } | { type: "EOSE" | "CLOSED" | "NOTICE"; sub?: string; msg?: string } | null {
  if (typeof data !== "string") return null;
  try {
    const m = JSON.parse(data) as unknown[];
    if (!Array.isArray(m)) return null;
    if (m[0] === "EVENT" && typeof m[1] === "string") return { type: "EVENT", sub: m[1], ev: m[2] };
    if (m[0] === "EOSE" || m[0] === "CLOSED") return { type: m[0], sub: String(m[1]), msg: m[2] ? String(m[2]) : undefined };
    if (m[0] === "NOTICE") return { type: "NOTICE", msg: String(m[1]) };
  } catch { /* ignore */ }
  return null;
}

export async function getState(db: D1Database): Promise<Record<string, { last_seen: number }>> {
  const { results } = await db.prepare("SELECT relay, last_seen FROM ingest_state").all<{ relay: string; last_seen: number }>();
  return Object.fromEntries((results ?? []).map((r) => [r.relay, { last_seen: r.last_seen }]));
}

export async function saveState(db: D1Database, relay: string, u: { maxCreated?: number; events?: number; rejected?: number; ok?: boolean; error?: string | null; now?: number }): Promise<void> {
  const now = Math.floor((u.now ?? Date.now()) / 1000);
  await db.prepare(`INSERT INTO ingest_state (relay,last_seen,last_event_at,last_ok_at,last_error,last_error_at,events_total,rejected) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(relay) DO UPDATE SET
      last_seen = MAX(ingest_state.last_seen, excluded.last_seen),
      last_event_at = COALESCE(excluded.last_event_at, ingest_state.last_event_at),
      last_ok_at = COALESCE(excluded.last_ok_at, ingest_state.last_ok_at),
      last_error = CASE WHEN excluded.last_error_at IS NOT NULL THEN excluded.last_error ELSE ingest_state.last_error END,
      last_error_at = COALESCE(excluded.last_error_at, ingest_state.last_error_at),
      events_total = ingest_state.events_total + excluded.events_total,
      rejected = ingest_state.rejected + excluded.rejected`)
    .bind(relay, u.maxCreated ?? 0, u.events ? now : null, u.ok ? now : null, u.error ?? null, u.error ? now : null, u.events ?? 0, u.rejected ?? 0).run();
}

async function knownFulfillments(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM nostr_events WHERE kind = ? ORDER BY first_seen DESC LIMIT 200").bind(NOSTR_KIND_FULFILLMENT).all<{ id: string }>();
  let notes: { id: string }[] = [];
  try { notes = (await db.prepare("SELECT id FROM experiences ORDER BY created_at DESC LIMIT 200").all<{ id: string }>()).results ?? []; } catch { /* migration pending */ }
  return [...(results ?? []), ...notes].map((r) => r.id);
}

/** One catch-up pass per relay: REQ with since = last seen - overlap, read until EOSE on every sub or timeout. */
export async function catchUp(db: D1Database, relays: string[], ctx: IngestCtx, connect: Connect = workerConnect, timeoutMs = INGEST_LIMITS.catchupTimeoutMs): Promise<Record<string, IngestResult & { error?: string }>> {
  const state = await getState(db);
  const fulIds = await knownFulfillments(db);
  const out: Record<string, IngestResult & { error?: string }> = {};
  // Reads run in parallel; D1 writes are serialized so cross-relay dedupe (and relay lists) stay exact.
  let writeChain: Promise<unknown> = Promise.resolve();
  await Promise.all(relays.map(async (relay) => {
    const since = Math.max(0, (state[relay]?.last_seen ?? 0) - INGEST_LIMITS.catchupOverlapS);
    const filters = buildFilters(ctx, since, fulIds);
    const events: { ev: unknown; relay: string }[] = [];
    let error: string | undefined;
    try {
      const ws = await connect(relay);
      await new Promise<void>((resolve) => {
        const pending = new Set(filters.map((_, i) => `km-cu-${i}`));
        const t = setTimeout(() => { error = `timeout before EOSE (${pending.size} subs open)`; resolve(); }, timeoutMs);
        ws.addEventListener("message", (e) => {
          const f = parseFrame(e.data);
          if (!f) return;
          if (f.type === "EVENT") events.push({ ev: f.ev, relay });
          else if ((f.type === "EOSE" || f.type === "CLOSED") && f.sub) {
            if (f.type === "CLOSED") error = `CLOSED ${f.sub}: ${f.msg ?? ""}`;
            pending.delete(f.sub);
            if (!pending.size) { clearTimeout(t); resolve(); }
          }
        });
        ws.addEventListener("close", () => { clearTimeout(t); if (pending.size) error = error ?? "closed early"; resolve(); });
        ws.addEventListener("error", () => { clearTimeout(t); error = "socket error"; resolve(); });
        filters.forEach((f, i) => ws.send(JSON.stringify(["REQ", `km-cu-${i}`, f])));
      });
      try { filters.forEach((_, i) => ws.send(JSON.stringify(["CLOSE", `km-cu-${i}`]))); ws.close(1000, "done"); } catch { /* closed */ }
    } catch (e) {
      error = `connect failed: ${(e as Error).message}`.slice(0, 200);
    }
    const job = writeChain.then(async () => {
      const r = await ingestEvents(db, events, ctx);
      await saveState(db, relay, { maxCreated: r.maxCreated, events: r.accepted + r.duplicate, rejected: r.rejected, ok: !error, error: error ?? null, now: ctx.now });
      out[relay] = { ...r, ...(error ? { error } : {}) };
    });
    writeChain = job.catch(() => undefined);
    await job;
  }));
  return out;
}
