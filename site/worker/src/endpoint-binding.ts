/**
 * M2 "open store", part 1: store endpoint bindings (v9.2 §2, build step 2). OBSERVATION ONLY: nothing that ranks, hides or
 * scores a store reads this module's output. The strongest claim made is "matches the latest binding KlickyMart saw".
 *
 * Event: one addressable event per store key, kind NOSTR_KIND_ENDPOINT_BINDING (PROVISIONAL, see nostr-kinds.ts), fixed
 * d tag BINDING_D. Content is canonical JSON (keys sorted, no whitespace) with a monotonic integer `version`, `expires_at`
 * and `endpoints` {bolt12_offer?, node_id?, lud16?, lnurl?, cashu_mints?}, or {revoked:true, version}.
 *
 * Rules (spec text, not invented): a new state needs BOTH version and created_at strictly higher, else `conflict`; a
 * created_at more than skew S ahead is rejected; an implausible version jump is `conflict`; same version + different
 * content is `conflict` carrying both events; revocation is terminal per store key and beats any version, created_at and
 * skew; expired, revoked and url_only are never a match. Store-authored payment strings are data: validated by shape only,
 * never fetched. Kill switch: KM_ENDPOINT_BINDINGS = 0|false|off (default on).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { verifyNostrEvent } from "./nostr-verify";
import { NOSTR_KIND_ENDPOINT_BINDING } from "./nostr-kinds";

export type BEv = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
export const BINDING_D = "klickymart-endpoints";
/** Starting guesses (v9.2: every number is one), not tuned values: skew S, version-jump threshold, rotation window, and the
 * cap on ORDINARY superseded states only (first state, conflict pairs and the revoke are never capped). */
export const BINDING_PARAMS = { skewS: 600, maxVersionJump: 1000, recentRotationS: 30 * 86400, historyCap: 32 };
export type BindingParams = typeof BINDING_PARAMS;

export type BindingStatus = "matches_observed_binding" | "url_only" | "mismatch" | "conflict" | "expired" | "revoked" | "none" | "unknown";
export interface Endpoints { bolt12_offer?: string; node_id?: string; lud16?: string; lnurl?: string; cashu_mints?: string[] }
export interface BindingContent { version: number; expires_at?: number; endpoints?: Endpoints; revoked?: true }
export interface Parsed { ev: BEv; c: BindingContent; hash: string }
export interface BindingState {
  pubkey: string;
  latest: BEv | null;            // last accepted (non-revoke) state
  revoked: BEv | null;           // terminal once set
  first: BEv | null;             // first accepted state: kept forever (evidence)
  conflicts: [BEv, BEv][];       // every conflict pair, both signed events; never dropped. Conflict is PERMANENT for the key
  seen: { version: number; hash: string; ev: BEv }[];  // ordinary superseded/accepted states only; capped at historyCap
  ignored: { count: number; last_hash: string | null };  // post-revoke, future-dated, stale replays: counted, not stored
  first_seen: number;            // KlickyMart's clock, never created_at
  changed_at: number | null;     // when KlickyMart saw the last accepted change after the first
}
export type Outcome = "accepted" | "duplicate" | "stale" | "conflict" | "revoked" | "ignored_after_revoke" | "ignored_future" | `rejected:${string}`;
export const IGNORED_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["stale", "ignored_after_revoke", "ignored_future"]);

export function bindingsEnabled(env: { KM_ENDPOINT_BINDINGS?: string }): boolean {
  const v = (env.KM_ENDPOINT_BINDINGS ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`).join(",")}}`;
  if (typeof x === "number" && !Number.isFinite(x)) throw new Error("non-finite number");
  return JSON.stringify(x);
}
export const hashHex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const ENDPOINT_SHAPES: Record<keyof Endpoints, (v: unknown) => boolean> = {
  bolt12_offer: (v) => typeof v === "string" && /^lno1[02-9ac-hj-np-z]{20,2000}$/.test(v),
  node_id: (v) => typeof v === "string" && /^0[23][0-9a-f]{64}$/.test(v),
  lud16: (v) => typeof v === "string" && v.length <= 320 && /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v),
  lnurl: (v) => typeof v === "string" && /^lnurl1[02-9ac-hj-np-z]{20,2000}$/.test(v),
  cashu_mints: (v) => Array.isArray(v) && v.length <= 16 && v.every((m) => typeof m === "string" && m.length <= 512 && /^https:\/\/[^\s]+$/.test(m)),
};

/** Strict parse: signature, kind, fixed d tag, canonical content, shapes. Never fetches anything. */
export function parseBinding(ev: BEv): { ok: true; value: Parsed } | { ok: false; reason: string } {
  const v = verifyNostrEvent(ev as never, NOSTR_KIND_ENDPOINT_BINDING);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (ev.tags.find((t) => t[0] === "d")?.[1] !== BINDING_D) return { ok: false, reason: "wrong d tag" };
  let c: Record<string, unknown>;
  try { c = JSON.parse(ev.content); } catch { return { ok: false, reason: "content not JSON" }; }
  if (!c || typeof c !== "object" || Array.isArray(c)) return { ok: false, reason: "content not an object" };
  if (canonicalJson(c) !== ev.content) return { ok: false, reason: "content not canonical" };
  if (!isInt(c.version)) return { ok: false, reason: "bad version" };
  if (c.revoked !== undefined) {
    if (c.revoked !== true || Object.keys(c).some((k) => k !== "revoked" && k !== "version")) return { ok: false, reason: "bad revoke" };
    return { ok: true, value: { ev, c: c as unknown as BindingContent, hash: hashHex(ev.content) } };
  }
  if (Object.keys(c).some((k) => !["version", "expires_at", "endpoints"].includes(k))) return { ok: false, reason: "unknown content field" };
  if (!isInt(c.expires_at)) return { ok: false, reason: "missing expires_at" };
  const e = c.endpoints as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object" || Array.isArray(e) || !Object.keys(e).length) return { ok: false, reason: "no endpoints" };
  for (const [k, val] of Object.entries(e)) {
    const shape = ENDPOINT_SHAPES[k as keyof Endpoints];
    if (!shape) return { ok: false, reason: `unknown endpoint ${k}` };
    if (!shape(val)) return { ok: false, reason: `bad ${k}` };
  }
  return { ok: true, value: { ev, c: c as unknown as BindingContent, hash: hashHex(ev.content) } };
}

export function emptyState(pubkey: string, nowS: number): BindingState {
  return { pubkey, latest: null, revoked: null, first: null, conflicts: [], seen: [], ignored: { count: 0, last_hash: null }, first_seen: nowS, changed_at: null };
}

/** Pure reducer. `prev` undefined = first sighting of this store key. */
export function applyBinding(prev: BindingState | undefined, ev: BEv, nowS: number, p: BindingParams = BINDING_PARAMS): { state: BindingState; outcome: Outcome } {
  const parsed = parseBinding(ev);
  if (!parsed.ok) return { state: prev ?? emptyState(ev.pubkey, nowS), outcome: `rejected:${parsed.reason}` };
  const { c, hash } = parsed.value;
  const s: BindingState = prev ? { ...prev, seen: [...prev.seen], conflicts: [...prev.conflicts], ignored: { ...prev.ignored } } : emptyState(ev.pubkey, nowS);
  if (s.pubkey !== ev.pubkey) return { state: s, outcome: "rejected:wrong store key" };
  const ignore = (o: Outcome) => { s.ignored.count++; s.ignored.last_hash = ev.id; return { state: s, outcome: o }; };
  if (s.revoked) return ignore("ignored_after_revoke");
  // Revocation beats version, created_at and skew S. Only a far-future event beyond S is refused (revoke or not).
  if (ev.created_at > nowS + p.skewS) return ignore("ignored_future");
  if (c.revoked) { s.revoked = ev; return { state: s, outcome: "revoked" }; }
  const known: { version: number; hash: string; ev: BEv }[] = [...s.seen, ...[s.first, s.latest, ...s.conflicts.flat()].filter((e): e is BEv => !!e).map((e) => ({ version: (JSON.parse(e.content) as BindingContent).version, hash: hashHex(e.content), ev: e }))];
  const sameVersion = known.filter((x) => x.version === c.version);
  if (sameVersion.some((x) => x.ev.id === ev.id || x.hash === hash)) return { state: s, outcome: "duplicate" };
  const remember = () => { s.seen.push({ version: c.version, hash, ev }); if (s.seen.length > p.historyCap) s.seen.splice(0, s.seen.length - p.historyCap); };
  const conflict = (a: BEv) => { s.conflicts.push([a, ev]); return { state: s, outcome: "conflict" as Outcome }; };
  if (sameVersion.length) return conflict(sameVersion[0]!.ev);
  const L = s.latest ? parseBinding(s.latest) : null;
  if (!L || !L.ok) { s.latest = ev; s.first ??= ev; remember(); return { state: s, outcome: "accepted" }; }
  const lv = L.value.c.version, lc = s.latest!.created_at;
  if (c.version > lv && ev.created_at > lc && c.version - lv <= p.maxVersionJump) {
    s.latest = ev; s.changed_at = nowS; remember(); return { state: s, outcome: "accepted" };
  }
  if (c.version > lv || ev.created_at > lc) return conflict(s.latest!);
  return ignore("stale");
}

const urlOnly = (e: Endpoints) => !e.node_id && !e.bolt12_offer && !!(e.lud16 || e.lnurl);

/** Status of a store key's binding at nowS. `unknown` = no trustworthy state (e.g. storage error / state loss). */
export function bindingStatus(s: BindingState | null | undefined | "unknown", nowS: number, opts: { ignoreConflict?: boolean } = {}): BindingStatus {
  if (s === "unknown") return "unknown";
  if (!s) return "none";
  if (s.revoked) return "revoked";
  if (!opts.ignoreConflict && s.conflicts?.length) return "conflict";
  if (!s.latest) return "none";
  const p = parseBinding(s.latest);
  if (!p.ok) return "unknown";
  if ((p.value.c.expires_at ?? 0) <= nowS) return "expired";
  if (urlOnly(p.value.c.endpoints ?? {})) return "url_only";
  return "matches_observed_binding";
}

/** Compare an endpoint actually presented (e.g. an invoice's node id or an offer) with the binding. Never a match unless
 * the status is matches_observed_binding AND the endpoint equals a bound node_id / bolt12_offer. URLs never match. */
export function matchEndpoint(s: BindingState | null | undefined | "unknown", nowS: number, used: { node_id?: string; bolt12_offer?: string; lud16?: string }): BindingStatus {
  const st = bindingStatus(s, nowS);
  if (st !== "matches_observed_binding") return st;
  const e = parseBinding((s as BindingState).latest!).ok ? (JSON.parse((s as BindingState).latest!.content) as BindingContent).endpoints ?? {} : {};
  if (used.node_id && e.node_id && used.node_id === e.node_id) return "matches_observed_binding";
  if (used.bolt12_offer && e.bolt12_offer && used.bolt12_offer === e.bolt12_offer) return "matches_observed_binding";
  if (!used.node_id && !used.bolt12_offer && used.lud16) return "url_only";
  return "mismatch";
}

export function recentRotation(s: BindingState | null | undefined | "unknown", nowS: number, p: BindingParams = BINDING_PARAMS): boolean | "unknown" {
  if (s === "unknown") return "unknown";
  if (!s) return false;
  return s.changed_at !== null && nowS - s.changed_at <= p.recentRotationS;
}

/** The raw signed events a result must carry so a harness can re-verify (first, latest, revoke, every conflict pair). */
export function evidenceEvents(s: BindingState | null | undefined): BEv[] {
  if (!s) return [];
  const out = [s.first, s.latest, s.revoked, ...(s.conflicts ?? []).flat()].filter((e): e is BEv => !!e && typeof e.sig === "string");
  return [...new Map(out.map((e) => [e.id, e])).values()];
}

// ---------- D1 storage (snapshot history is normative; every accepted state and all evidence is kept) ----------

export async function loadBindingState(db: D1Database, pubkey: string): Promise<BindingState | null | "unknown"> {
  try {
    const r = await db.prepare("SELECT state_json FROM endpoint_binding_state WHERE pubkey = ?").bind(pubkey).first<{ state_json: string }>();
    return r ? (JSON.parse(r.state_json) as BindingState) : null;
  } catch { return "unknown"; }
}

/** Ingest binding events (already relay-validated or not: signatures are re-checked here). Never throws. */
export async function recordBindings(db: D1Database, evs: BEv[], nowS: number, p: BindingParams = BINDING_PARAMS): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const mine = evs.filter((e) => e && e.kind === NOSTR_KIND_ENDPOINT_BINDING).sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  const states = new Map<string, BindingState | null | "unknown">();
  for (const ev of mine) {
    if (!states.has(ev.pubkey)) states.set(ev.pubkey, await loadBindingState(db, ev.pubkey));
    const prev = states.get(ev.pubkey);
    if (prev === "unknown") { counts.unknown = (counts.unknown ?? 0) + 1; continue; }
    const { state, outcome } = applyBinding(prev ?? undefined, ev, nowS, p);
    const k = outcome.split(":")[0]!; counts[k] = (counts[k] ?? 0) + 1;
    if (outcome.startsWith("rejected") || outcome === "duplicate") continue;
    states.set(ev.pubkey, state);
    const keep = !IGNORED_OUTCOMES.has(outcome); // ignored events: counter + last hash only, never stored
    try {
      let version = -1; try { version = (JSON.parse(ev.content) as BindingContent).version; } catch { /* parsed above */ }
      await db.batch([
        ...(keep ? [db.prepare("INSERT OR IGNORE INTO endpoint_binding_events (id,pubkey,version,created_at,content_hash,outcome,raw_json,seen_at) VALUES (?,?,?,?,?,?,?,?)").bind(ev.id, ev.pubkey, version, ev.created_at, hashHex(ev.content), outcome, JSON.stringify(ev), nowS)] : []),
        db.prepare("INSERT OR REPLACE INTO endpoint_binding_state (pubkey,state_json,ignored_count,last_ignored_hash,updated_at) VALUES (?,?,?,?,?)").bind(ev.pubkey, JSON.stringify(state), state.ignored.count, state.ignored.last_hash, nowS),
      ]);
    } catch { counts.store_error = (counts.store_error ?? 0) + 1; }
  }
  return counts;
}
