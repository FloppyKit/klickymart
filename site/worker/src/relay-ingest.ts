import { markFacilitatedHistory, revokeFacilitated, FACILITATOR_PUBKEY } from "./facilitate";
import { refreshFlagCache } from "./flags";
import { nip05Pass } from "./nip05";
import { recordHandshakeMarks } from "./handshake-marks";
import { recordBindings, BINDING_D, type BEv } from "./endpoint-binding";
import { NOSTR_KIND_ENDPOINT_BINDING } from "./nostr-kinds";
/** Relay ingest core: filters, validation, storage, proof checks, catch-up. Transport-agnostic (socket injected). */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { NOSTR_KIND_ACCEPTANCE, NOSTR_KIND_CRAWL_RECORD, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_NEED, NOSTR_KIND_STORE_SUGGESTION } from "./nostr-kinds";
import { parseSuggestionEvent, submitStore } from "./submissions";
import type { NostrEventLine } from "./nostr-record-source";
import { verifyNostrEvent } from "./nostr-verify";
import { parseReviewEvent, storeReview } from "./reviews";
import { KIND_NOTE, NOTE_HASHTAG, parseExperience, storeExperience } from "./experience";
import { take } from "./ratelimit";
import { lnurlNostrPubkey, lud16Of, type Fetcher, checkPreimage, checkZapReceipt, NO_BINDINGS, storeBindings, type StoreBindings } from "./pay-binding";

export const ZAP_RECEIPT_KIND = 9735;
export const NUTZAP_KIND = 9321;
export const NUTZAP_INFO_KIND = 10019;
export const DELETION_KIND = 5;
/** KIMI-008: frame and buffer bounds applied when a frame is received, before it is buffered. */
export const BUFFER_LIMITS = { maxFrameBytes: 65536 + 1024, liveMaxEvents: 2000, liveMaxBytes: 4 * 1024 * 1024, catchupMaxEvents: 5000, catchupMaxBytes: 8 * 1024 * 1024 };
export const INGEST_LIMITS = { perPubkeyPerDay: 200, receiptsPerSignerPerDay: 1000, suggestionsPerDay: 50, maxEventBytes: 65536, catchupTimeoutMs: 12_000, catchupOverlapS: 600 }; // KIMI-009: overlap >= the 600 s future-skew we accept
/** KM-007: relay-ingested notes/reviews older than this are rejected (was ~10 years), and nothing more than
 * MAX_FUTURE_S ahead of our clock is accepted. Key age is judged on first_seen (ingest time), never on created_at. */
export const RELAY_NOTE_MAX_AGE_S = 60 * 86400;
export const MAX_FUTURE_S = 600;

export interface IngestCtx {
  indexStatus?: (d: string) => string | undefined;
  flagStatic?: import("./flags").FlagStatic;
  domains: Set<string>;
  ourPubkey: string | null;
  now?: number;
  /** True only while /facilitate is enabled; otherwise every facilitator-signed 421 that arrives is revoked on ingest. */
  facilitationEnabled?: boolean;
  /** Outbound fetch for NIP-57 LNURL lookups (tests inject a fake). */
  fetcher?: Fetcher;
  /** KM_HANDSHAKE_MARKS kill switch (default on). false = the 420/421/422 validator is not called at all. Marks only. */
  handshakeMarks?: boolean;
  /** Test hook: replaces checkThreads. */
  handshakeChecker?: typeof import("./handshake").checkThreads;
  /** M2 KM_ENDPOINT_BINDINGS kill switch (default on). false = the binding kind is not subscribed, validated or stored. */
  endpointBindings?: boolean;
}

export type Ev = Required<Pick<NostrEventLine, "id" | "pubkey" | "sig" | "kind" | "created_at" | "tags" | "content">>;

export function relayList(raw: string | undefined): string[] {
  return (raw ?? "").replace(/[\\[\\]"]/g, "").split(",").map((x) => x.trim()).filter((x) => /^wss?:\/\//.test(x));
}

/** REQ filters for one relay. */
export function buildFilters(ctx: IngestCtx, since: number, fulfillmentIds: string[] = [], noteAuthors: string[] = []): Record<string, unknown>[] {
  const domains = [...ctx.domains].sort();
  const f: Record<string, unknown>[] = [
    { kinds: [NOSTR_KIND_CRAWL_RECORD], since },
    { kinds: [NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE], "#r": domains, since },
  ];
  if (ctx.ourPubkey) f.push({ kinds: [NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE], "#a": domains.map((d) => `${NOSTR_KIND_CRAWL_RECORD}:${ctx.ourPubkey}:${d}`), since });
  // Zap receipts on known 421s (payment proof) and on known 422/kind-1 notes (tips; see tips.ts).
  if (fulfillmentIds.length) f.push({ kinds: [ZAP_RECEIPT_KIND], "#e": fulfillmentIds.slice(0, 400) });
  // Cashu nutzaps (NIP-61) on the same notes: display only, never ranking weight (tip-rails.ts).
  if (fulfillmentIds.length) f.push({ kinds: [NUTZAP_KIND], "#e": fulfillmentIds.slice(0, 400) });
  // NIP-09 deletions of anything we store (by id) and of notes tagged for us (k tags); applied only when the author matches.
  if (fulfillmentIds.length) f.push({ kinds: [DELETION_KIND, 1984], "#e": fulfillmentIds.slice(0, 400) });
  f.push({ kinds: [DELETION_KIND], "#k": [String(NOSTR_KIND_ACCEPTANCE), String(NOSTR_KIND_FULFILLMENT), String(NOSTR_KIND_NEED), String(KIND_NOTE)], since });
  // Profiles (kind 0) only for keys that posted notes: used for NIP-05 same-operator hints (flags.ts / nip05.ts).
  if (noteAuthors.length) f.push({ kinds: [0], authors: noteAuthors.slice(0, 200) });
  // Nutzap info (NIP-61 kind 10019: mints, relays, P2PK key) for the same authors: tip-ready Cashu rail.
  if (noteAuthors.length) f.push({ kinds: [NUTZAP_INFO_KIND], authors: noteAuthors.slice(0, 200) });
  // Shopping experiences: structured 422s tagged #klickymart (any store) and unstructured kind-1 notes tagged #klickymart.
  f.push({ kinds: [NOSTR_KIND_ACCEPTANCE, KIND_NOTE], "#t": [NOTE_HASHTAG], since });
  // Community store suggestions (Path 3): signed kind 1423 with an r tag; queued for the gated crawl, never trusted for facts.
  f.push({ kinds: [NOSTR_KIND_STORE_SUGGESTION], since });
  // M2 endpoint bindings (observation only; never ranking).
  if (ctx.endpointBindings !== false) f.push({ kinds: [NOSTR_KIND_ENDPOINT_BINDING], "#d": [BINDING_D], since });
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
  if (ev.kind === NOSTR_KIND_ENDPOINT_BINDING && ctx.endpointBindings !== false) {
    const v = verifyNostrEvent(ev, ev.kind);
    return v.ok ? { ok: true, d: null } : { ok: false, reason: v.reason }; // content rules + future skew: endpoint-binding.ts
  }
  if (![NOSTR_KIND_CRAWL_RECORD, NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE, ZAP_RECEIPT_KIND, NUTZAP_KIND, NUTZAP_INFO_KIND, KIND_NOTE, DELETION_KIND, 1984, 0, NOSTR_KIND_STORE_SUGGESTION].includes(ev.kind)) return { ok: false, reason: "kind not followed" };
  if (ev.kind === KIND_NOTE) {
    const x = parseExperience(ev, (dd) => ctx.domains.has(dd), ctx.now ?? Date.now(), { maxAgeS: RELAY_NOTE_MAX_AGE_S });
    return x.ok ? { ok: true, d: x.value.d } : { ok: false, reason: `note: ${x.message}` };
  }
  const v = verifyNostrEvent(ev, ev.kind);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return { ok: false, reason: "bad tags" };
  if (ev.created_at > Math.floor((ctx.now ?? Date.now()) / 1000) + MAX_FUTURE_S) return { ok: false, reason: "future created_at" };
  if (ev.kind === ZAP_RECEIPT_KIND) return { ok: true, d: null };
  if (ev.kind === 0) return { ok: true, d: null };
  if (ev.kind === NUTZAP_KIND) return ev.tags.some((t) => t[0] === "e" && /^[0-9a-f]{64}$/.test(t[1] ?? "")) && ev.tags.some((t) => t[0] === "proof") ? { ok: true, d: null } : { ok: false, reason: "nutzap without e or proof" };
  if (ev.kind === NUTZAP_INFO_KIND) return { ok: true, d: null };
  if (ev.kind === NOSTR_KIND_STORE_SUGGESTION) { const p = parseSuggestionEvent(ev, ctx.now ?? Date.now(), 365 * 86400); return p.ok ? { ok: true, d: null } : { ok: false, reason: `1423: ${p.message}` }; }
  if (ev.kind === 1984) return ev.tags.some((t) => t[0] === "e" && /^[0-9a-f]{64}$/.test(t[1] ?? "")) ? { ok: true, d: null } : { ok: false, reason: "report without e tag" };
  if (ev.kind === DELETION_KIND) return ev.tags.some((t) => t[0] === "e" && /^[0-9a-f]{64}$/.test(t[1] ?? "")) ? { ok: true, d: null } : { ok: false, reason: "deletion without e tags" };
  const d = eventDomain(ev, ctx);
  if (ev.kind === NOSTR_KIND_CRAWL_RECORD) {
    if (!d) return { ok: false, reason: "31420 without valid d tag" };
    if (!ctx.domains.has(d)) return { ok: false, reason: "31420 for a domain not in the index" }; // KM-009
    try { JSON.parse(ev.content); } catch { return { ok: false, reason: "31420 content is not JSON" }; }
    return { ok: true, d };
  }
  if (!d) return { ok: false, reason: "does not reference an indexed merchant (a 31420:*:<domain> or r tag)" };
  if (ev.kind === NOSTR_KIND_ACCEPTANCE && tagv(ev.tags, "rating") !== undefined) {
    const r = parseReviewEvent(ev, (x) => ctx.domains.has(x), ctx.now ?? Date.now(), { maxAgeS: RELAY_NOTE_MAX_AGE_S });
    const x = r.ok ? null : parseExperience(ev, (dd) => ctx.domains.has(dd), ctx.now ?? Date.now(), { maxAgeS: RELAY_NOTE_MAX_AGE_S });
    if (!r.ok && !x?.ok) return { ok: false, reason: `review: ${r.message}` };
  }
  return { ok: true, d };
}

/** Payment proof checks (KM-001). Both proofs must be bound to the store:
 * preimage: the cited 421's BOLT11 is node-signed by one of the store's ln_node keys and sha256(preimage) == payment_hash;
 * zap: the 9735 receipt references the 421, is signed by one of the store's zap_pubkey keys (its LNURL nostrPubkey, NIP-57),
 * and its BOLT11 is node-signed with description_hash == sha256(9734). Anything else is "unverified-claim".
 * Store keys come from storeBindings() (claimed owners' own 31420 tags); an unclaimed store has none. */
export function checkProof(review: Ev, fulfillment: Ev | null, zapReceipt: Ev | null, bind: StoreBindings = NO_BINDINGS, d?: string | null): "verified-preimage" | "verified-zap" | "unverified-claim" | "facilitated-unverified" | null {
  const ful = review.tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1];
  const pre = tagv(review.tags, "preimage"); const zap = tagv(review.tags, "zap"); const cashu = tagv(review.tags, "cashu");
  if (!ful && !pre && !zap && !cashu) return null;
  if (!ful || !fulfillment || fulfillment.id !== ful || fulfillment.kind !== NOSTR_KIND_FULFILLMENT) return "unverified-claim";
  const fr = tagv(fulfillment.tags, "r")?.toLowerCase();
  if (d && fr && fr !== d) return "unverified-claim"; // a 421 for another store proves nothing here
  if (fulfillment.pubkey !== FACILITATOR_PUBKEY) {
    if (pre && checkPreimage(pre, tagv(fulfillment.tags, "bolt11"), bind.nodes)) return "verified-preimage";
    if (zap && zapReceipt && zapReceipt.id === zap && zapReceipt.tags.some((t) => t[0] === "e" && t[1] === ful)
      && checkZapReceipt(zapReceipt, bind.zapKeys).ok) return "verified-zap";
  }
  // A 421 KlickyMart signed as facilitator is never store-bound: no proof bonus, plain-note weight.
  if (fulfillment.pubkey === FACILITATOR_PUBKEY) return "facilitated-unverified";
  return "unverified-claim";
}

/** R6-001: first key to use a checked payment proof wins it. Returns ps unchanged unless another key already holds one of
 * this note's proof keys, in which case "replayed-proof" (plain-note weight, no proof bonus). Fails closed on DB error. */
export async function bindProof(db: D1Database, ps: string | null, ev: Ev, nowS: number): Promise<string | null> {
  if (!ps?.startsWith("verified")) return ps;
  const keys: string[] = []; const ful = ev.tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1]; if (ful) keys.push("ful:" + ful);
  const pre = tagv(ev.tags, "preimage"); if (ps === "verified-preimage" && pre && /^[0-9a-f]{64}$/i.test(pre)) keys.push("ph:" + bytesToHex(sha256(hexToBytes(pre.toLowerCase()))));
  const zap = tagv(ev.tags, "zap"); if (ps === "verified-zap" && zap) keys.push("zap:" + zap.toLowerCase());
  try {
    await db.batch(keys.map((k) => db.prepare("INSERT OR IGNORE INTO proof_uses (proof_key, pubkey, note_id, first_seen) VALUES (?,?,?,?)").bind(k, ev.pubkey, ev.id, nowS)));
    const { results } = await db.prepare(`SELECT pubkey FROM proof_uses WHERE proof_key IN (${keys.map(() => "?").join(",")})`).bind(...keys).all<{ pubkey: string }>();
    return (results ?? []).length === keys.length && (results ?? []).every((r) => r.pubkey === ev.pubkey) ? ps : "replayed-proof";
  } catch { return "replayed-proof"; }
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
export const MAX_UNSEEN_TOMBSTONES = 10;
export async function applyDeletion(db: D1Database, del: Ev, nowS: number): Promise<{ deleted: string[]; ignored: string[] }> {
  const out = { deleted: [] as string[], ignored: [] as string[] }; let unseen = 0;
  for (const id of [...new Set(del.tags.filter((t) => t[0] === "e" && /^[0-9a-f]{64}$/.test(t[1] ?? "")).map((t) => t[1]!))].slice(0, 100)) {
    const row = await db.prepare("SELECT pubkey FROM nostr_events WHERE id = ?").bind(id).first<{ pubkey: string }>();
    let author = row?.pubkey;
    if (!author) { try { author = (await db.prepare("SELECT pubkey FROM experiences WHERE id = ? UNION SELECT pubkey FROM reviews WHERE id = ?").bind(id, id).first<{ pubkey: string }>())?.pubkey; } catch { /* */ } }
    if (author && author !== del.pubkey) { out.ignored.push(id); continue; }
    if (!author && ++unseen > MAX_UNSEEN_TOMBSTONES) { out.ignored.push(id); continue; } // K-DEL: bound tombstones for ids we never held
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
  if (ctx.endpointBindings !== false && valid.some((x) => x.ev.kind === NOSTR_KIND_ENDPOINT_BINDING)) {
    const bevs = valid.filter((x) => x.ev.kind === NOSTR_KIND_ENDPOINT_BINDING).map((x) => x.ev as BEv);
    const c = await recordBindings(db, bevs, nowS);
    res.accepted += (c.accepted ?? 0) + (c.conflict ?? 0) + (c.revoked ?? 0); // ignored ones (stale, post-revoke, future) land in reasons
    res.duplicate += c.duplicate ?? 0;
    for (const [k, n] of Object.entries(c)) if (!["accepted", "conflict", "revoked", "duplicate"].includes(k)) { res.rejected += n; res.reasons[`binding ${k}`] = (res.reasons[`binding ${k}`] ?? 0) + n; }
    for (let k = valid.length - 1; k >= 0; k--) if (valid[k]!.ev.kind === NOSTR_KIND_ENDPOINT_BINDING) valid.splice(k, 1);
  }
  const dels = valid.filter((x) => x.ev.kind === DELETION_KIND);
  if (dels.length) {
    // K-DEL / KM-009: kind 5 counts against the same per-key daily cap as other events (by distinct deletions applied
    // in the last day, from the tombstones they wrote). Fails closed on a storage error.
    const used = new Map<string, number>();
    for (const { ev } of dels) {
      if (!used.has(ev.pubkey)) {
        try { used.set(ev.pubkey, (await db.prepare("SELECT COUNT(DISTINCT deletion_id) AS n FROM tombstones WHERE pubkey = ? AND deleted_at > ?").bind(ev.pubkey, nowS - 86400).first<{ n: number }>())?.n ?? 0); }
        catch { used.set(ev.pubkey, Infinity); }
      }
      if (used.get(ev.pubkey)! >= INGEST_LIMITS.perPubkeyPerDay) { reject("rate-limited pubkey"); continue; }
      used.set(ev.pubkey, used.get(ev.pubkey)! + 1);
      await applyDeletion(db, ev, nowS); res.accepted++;
    }
    for (let k = valid.length - 1; k >= 0; k--) if (valid[k]!.ev.kind === DELETION_KIND) valid.splice(k, 1);
  }
  if (valid.length) {
    const ids0 = [...new Set(valid.map((x) => x.ev.id))];
    const tomb = new Set<string>(); // KM-010: (id, author) pairs
    for (let k = 0; k < ids0.length; k += 90) {
      const chunk = ids0.slice(k, k + 90);
      try {
        const { results } = await db.prepare(`SELECT id, pubkey FROM tombstones WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ id: string; pubkey: string }>();
        for (const r of results ?? []) tomb.add(`${r.id}|${r.pubkey}`);
      } catch { /* migration pending */ }
    }
    for (let k = valid.length - 1; k >= 0; k--) if (tomb.has(`${valid[k]!.ev.id}|${valid[k]!.ev.pubkey}`)) { valid.splice(k, 1); reject("deleted by author (tombstone)"); }
  }
  if (!valid.length) { if (res.accepted) await refreshFlagCache(db, ctx.flagStatic); return res; }
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
  // KM-009: zap receipts are kept only when they point at a note/421 we hold (or one in this batch).
  const heldTargets = new Set(valid.filter((x) => x.ev.kind !== ZAP_RECEIPT_KIND && x.ev.kind !== NUTZAP_KIND).map((x) => x.ev.id));
  const rTargets = [...new Set(valid.filter((x) => x.ev.kind === ZAP_RECEIPT_KIND || x.ev.kind === NUTZAP_KIND).map((x) => tagv(x.ev.tags, "e")).filter((x): x is string => !!x && /^[0-9a-f]{64}$/.test(x)))];
  for (let k = 0; k < rTargets.length; k += 30) {
    const chunk = rTargets.slice(k, k + 30); const q = chunk.map(() => "?").join(",");
    for (const sql of [`SELECT id FROM nostr_events WHERE id IN (${q}) AND kind NOT IN (${ZAP_RECEIPT_KIND}, ${NUTZAP_KIND})`, `SELECT id FROM experiences WHERE id IN (${q})`, `SELECT id FROM reviews WHERE id IN (${q})`]) {
      try { for (const r of (await db.prepare(sql).bind(...chunk).all<{ id: string }>()).results ?? []) heldTargets.add(r.id); } catch { /* table missing */ }
    }
  }
  const stmts: D1PreparedStatement[] = [];
  const reviews: Ev[] = [];
  const suggestions: Ev[] = [];
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
    if (ev.kind === ZAP_RECEIPT_KIND) { // KM-009: receipts only for notes/421s we hold, and capped per signer (LNURL servers sign for many payers)
      const target = tagv(ev.tags, "e");
      if (!target || !(heldTargets.has(target))) { reject("zap receipt for an event we do not hold"); continue; }
    }
    if (ev.kind === NUTZAP_KIND) { const target = tagv(ev.tags, "e"); if (!target || !heldTargets.has(target)) { reject("nutzap for an event we do not hold"); continue; } }
    if (ev.pubkey !== ctx.ourPubkey) {
      const n = pkCount.get(ev.pubkey) ?? 0;
      const cap = ev.kind === ZAP_RECEIPT_KIND ? INGEST_LIMITS.receiptsPerSignerPerDay : INGEST_LIMITS.perPubkeyPerDay;
      if (n >= cap) { reject("rate-limited pubkey"); continue; }
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
    if (ev.kind === NOSTR_KIND_STORE_SUGGESTION) suggestions.push(ev);
    res.accepted++;
  }
  for (let k = 0; k < stmts.length; k += 200) await db.batch(stmts.slice(k, k + 200));
  // Runtime caller for revokeFacilitated(): facilitator 421s re-seen from relays while facilitation is paused are revoked.
  if (!ctx.facilitationEnabled) { const fac = valid.filter((x) => x.ev.kind === NOSTR_KIND_FULFILLMENT && x.ev.pubkey === FACILITATOR_PUBKEY).map((x) => x.ev.id);
    if (fac.length) { try { await revokeFacilitated(db, { ids: fac, reason: "facilitated-before-pause" }); } catch { /* migration pending */ } } }
  for (const ev of exps) {
    const x = parseExperience(ev, (dd) => ctx.domains.has(dd), now, { maxAgeS: RELAY_NOTE_MAX_AGE_S });
    if (!x.ok) continue;
    let ps: string | null = null;
    if (ev.kind === NOSTR_KIND_ACCEPTANCE && x.value.proof) { try { ps = checkProof(ev, await getEvent(db, ev.tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1]), await getEvent(db, tagv(ev.tags, "zap")), await storeBindings(db, x.value.d), x.value.d); ps = await bindProof(db, ps, ev, Math.floor(now / 1000)); } catch { ps = null; } }
    try { await storeExperience(db, x.value, ev, { source: "relay", relays: existing.get(ev.id) ?? null, proof_status: ps ?? (x.value.proof ? "proof-attached" : null) }, now); } catch { /* migration pending */ }
  }
  for (const ev of suggestions) {
    const p = parseSuggestionEvent(ev, now, 365 * 86400);
    if (ev.tags.some((t) => t[0] === "claim")) continue; // claims need a live DNS check: POST /claim/dns
    // KM-009: a global daily cap on relay-sourced crawl-queue suggestions (fresh keys are free to mint).
    if (p.ok) { try { if (!(await take(db, { k: `sug:g:${new Date(now).toISOString().slice(0, 10)}`, limit: INGEST_LIMITS.suggestionsPerDay, ttlS: 2 * 86400 }))) continue; } catch { /* migration pending */ } }
    if (p.ok) { try { await submitStore({}, { db, indexed: ctx.domains, salt: "", ip: null, via: "nostr", signed: p.value, now, origin: "https://klickymart.com" }); } catch { /* migration pending */ } }
  }
  for (const ev of reviews) {
    const p = parseReviewEvent(ev, (x) => ctx.domains.has(x), now, { maxAgeS: RELAY_NOTE_MAX_AGE_S });
    if (!p.ok) continue;
    const ful = await getEvent(db, p.value.fulfillment ?? undefined);
    const zap = await getEvent(db, tagv(ev.tags, "zap"));
    await storeReview(db, p.value, ev, now, { source: "relay", relays: existing.get(ev.id) ?? null, proof_status: await bindProof(db, checkProof(ev, ful, zap, await storeBindings(db, p.value.d), p.value.d), ev, Math.floor(now / 1000)) });
  }
  // KM-003: resolve the zapped author's LNURL nostrPubkey (NIP-57) so tips can be checked against it. Bounded per batch.
  let lookups = 0;
  for (const { ev } of valid) {
    if (ev.kind !== ZAP_RECEIPT_KIND || lookups >= 10) continue;
    const target = tagv(ev.tags, "e"); if (!target) continue;
    try {
      const a = await db.prepare("SELECT pubkey FROM experiences WHERE id = ? UNION SELECT pubkey FROM reviews WHERE id = ? LIMIT 1").bind(target, target).first<{ pubkey: string }>();
      const lud = a ? await lud16Of(db, a.pubkey) : null;
      if (lud) { lookups++; await lnurlNostrPubkey(db, lud, ctx.fetcher ?? fetch); }
    } catch { /* tables missing */ }
  }
  if (res.accepted) await refreshFlagCache(db, ctx.flagStatic);
  const touched = new Set([...reviews, ...exps, ...valid.filter((x) => x.ev.kind === NOSTR_KIND_FULFILLMENT).map((x) => x.ev)].map((e) => eventDomain(e, ctx) ?? tagv(e.tags, "r")).filter((x): x is string => !!x));
  for (const d of touched) await markFacilitatedHistory(db, d);
  // M1: factual marks on 420/421/422 (display/audit only; no ranking or visibility effect).
  if (ctx.handshakeMarks !== false) await recordHandshakeMarks(db, valid.map((x) => x.ev), nowS, ctx.handshakeChecker);
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
export function parseFrame(data: unknown, maxBytes = BUFFER_LIMITS.maxFrameBytes): { type: "EVENT"; sub: string; ev: unknown } | { type: "EOSE" | "CLOSED" | "NOTICE"; sub?: string; msg?: string } | null {
  if (typeof data !== "string" || data.length > maxBytes) return null; // KIMI-008: oversize frames are dropped unparsed
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
    .bind(relay, Math.min(u.maxCreated ?? 0, now), u.events ? now : null, u.ok ? now : null, u.error ?? null, u.error ? now : null, u.events ?? 0, u.rejected ?? 0).run();
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
  let authors: string[] = [];
  try { authors = ((await db.prepare("SELECT DISTINCT pubkey FROM experiences LIMIT 200").all<{ pubkey: string }>()).results ?? []).map((r) => r.pubkey); } catch { /* */ }
  const out: Record<string, IngestResult & { error?: string }> = {};
  // Reads run in parallel; D1 writes are serialized so cross-relay dedupe (and relay lists) stay exact.
  let writeChain: Promise<unknown> = Promise.resolve();
  await Promise.all(relays.map(async (relay) => {
    const since = Math.max(0, Math.min(state[relay]?.last_seen ?? 0, Math.floor((ctx.now ?? Date.now()) / 1000)) - INGEST_LIMITS.catchupOverlapS); // KIMI-009: a future-dated watermark cannot skip events
    const filters = buildFilters(ctx, since, fulIds, authors);
    const events: { ev: unknown; relay: string }[] = [];
    let error: string | undefined; let bytes = 0;
    try {
      const ws = await connect(relay);
      await new Promise<void>((resolve) => {
        const pending = new Set(filters.map((_, i) => `km-cu-${i}`));
        const t = setTimeout(() => { error = `timeout before EOSE (${pending.size} subs open)`; resolve(); }, timeoutMs);
        ws.addEventListener("message", (e) => {
          const f = parseFrame(e.data);
          if (!f) return;
          if (f.type === "EVENT") {
            bytes += String(e.data).length;
            if (events.length >= BUFFER_LIMITS.catchupMaxEvents || bytes > BUFFER_LIMITS.catchupMaxBytes) { // KIMI-008
              error = `catch-up cap reached (${events.length} events, ${bytes} bytes); rest on the next pass`; clearTimeout(t); resolve(); return;
            }
            events.push({ ev: f.ev, relay });
          }
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
  if (ctx.indexStatus && (await nip05Pass(db, (u, i) => fetch(u, i), ctx.indexStatus)) > 0) await refreshFlagCache(db, ctx.flagStatic);
  return out;
}
