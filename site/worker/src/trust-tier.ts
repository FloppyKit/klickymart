import { visibleSql } from "./takedown";
/** M4 S4: trust tiers. "new-and-risky" (default) or "established". Tiers only LIFT a store in ranking; nothing is hidden.
 * established = ALL of: first seen by us >= 90 days ago, domain registered >= 1 year ago, >= 5 distinct in-graph buyers
 * (completed 420 -> 421 -> 422 threads; never the store's own keys; amounts/tips ignored), and no undismissed in-graph
 * complaint. Graph = seed (KM_TRUST_SEED_NPUB, the KlickyMart account) + 2 hops of kind-3 follows, read from our own relay.
 * Flags (default OFF): KM_TRUST_LABELS (labels + ranking), KM_TRUST_BUYS (buy/complaint inputs; off = buys unknown, so
 * nobody is established). Tip modules (tips.ts, tip-rails.ts) are never imported here. */
import { bech32 } from "@scure/base";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { checkThreads, type NostrEventLine } from "./handshake";
import { verifyNostrEvent } from "./nostr-verify";
import type { NostrEventLine as RawLine } from "./nostr-record-source";
import { canonicalJson } from "./endpoint-binding";
import type { Connect } from "./relay-ingest";

const on = (v?: string) => { const s = (v ?? "").trim().toLowerCase(); return s === "1" || s === "true" || s === "on"; };
export const trustLabelsEnabled = (env: { KM_TRUST_LABELS?: string }) => on(env.KM_TRUST_LABELS);
export const trustBuysEnabled = (env: { KM_TRUST_BUYS?: string }) => on(env.KM_TRUST_BUYS);

export type Tier = "new-and-risky" | "established";
export const RULE_V = 1, MIN_BUYERS = 5, MIN_FIRST_SEEN_S = 90 * 86400, MIN_DOMAIN_AGE_S = 365 * 86400;
export interface TrustField { tier: Tier; rule_v: 1; reasons: string[]; in_graph_buyers: number | null; complaints: number | null; graph_hash: string | null; checked_at: string }
const HEX64 = /^[0-9a-f]{64}$/;

/** NIP-19 npub -> 64-hex pubkey; null on a bad checksum, wrong prefix or wrong length. */
export function npubToHex(npub: string | undefined): string | null {
  if (!npub || !npub.startsWith("npub1")) return null;
  try {
    const d = bech32.decode(npub as `${string}1${string}`, 90);
    if (d.prefix !== "npub") return null;
    const b = bech32.fromWords(d.words);
    return b.length === 32 ? bytesToHex(b) : null;
  } catch { return null; }
}

export interface TierInput { firstSeenAt: number | null; registeredAt: number | null; buyers: number | null; complaints: number | null; graphHash: string | null; nowS: number }
export function tierFor(i: TierInput): TrustField {
  const r: string[] = [];
  if (i.firstSeenAt === null) r.push("first_seen_unknown"); else if (i.nowS - i.firstSeenAt < MIN_FIRST_SEEN_S) r.push("first_seen<90d");
  if (i.registeredAt === null) r.push("domain_age_unknown"); else if (i.nowS - i.registeredAt < MIN_DOMAIN_AGE_S) r.push("domain_age<1y");
  if (i.buyers === null) r.push("buys_unknown"); else if (i.buyers < MIN_BUYERS) r.push(`buyers:${i.buyers}/${MIN_BUYERS}`);
  if (i.complaints === null) r.push("complaints_unknown"); else if (i.complaints > 0) r.push("complaint");
  return { tier: r.length ? "new-and-risky" : "established", rule_v: 1, reasons: r, in_graph_buyers: i.buyers, complaints: i.complaints, graph_hash: i.graphHash, checked_at: new Date(i.nowS * 1000).toISOString() };
}
export const DEFAULT_TRUST = (nowS: number): TrustField => tierFor({ firstSeenAt: null, registeredAt: null, buyers: null, complaints: null, graphHash: null, nowS });
/** Rank key: established sorts before new-and-risky; that is the only effect (no row is ever removed). */
export const tierRank = (t: TrustField | undefined) => (t?.tier === "established" ? 0 : 1);

// ---------------- derivation (pure) ----------------
export interface Buy { event_id: string; store_domain: string; buyer_pubkey: string; thread_root: string; created_at: number }
export interface Complaint { event_id: string; store_domain: string; author_pubkey: string; thread_root: string; created_at: number }

/** Completed threads -> buys. storeKeys: pubkey -> domain (active store claims). A buy needs: a valid loop, the 421 author
 * mapped to a store, an accepted 422 by the 420 author, and a buyer that is not any key of that store. */
export function deriveBuys(events: NostrEventLine[], storeKeys: Map<string, string>, opts: { checkSig?: boolean } = {}): Buy[] {
  const rep = checkThreads(events, opts);
  const keysOf = new Map<string, Set<string>>();
  for (const [pk, d] of storeKeys) { if (!keysOf.has(d)) keysOf.set(d, new Set()); keysOf.get(d)!.add(pk); }
  const out: Buy[] = [];
  for (const l of rep.loops) {
    const need = rep.byId.get(l.need)?.result.parsed, ful = rep.byId.get(l.fulfillment)?.result.parsed;
    if (!need || !ful || need.kind !== 420 || ful.kind !== 421) continue;
    const domain = storeKeys.get(ful.pubkey);
    if (!domain || need.pubkey === ful.pubkey || keysOf.get(domain)!.has(need.pubkey)) continue;
    const accId = l.acceptances.find((id) => { const a = rep.byId.get(id); return a && a.result.ok && a.result.parsed?.kind === 422 && a.result.parsed.pubkey === need.pubkey && a.result.parsed.status === "accepted"; });
    if (!accId) continue;
    const ev = events.find((e) => e.id === accId)!;
    out.push({ event_id: accId, store_domain: domain, buyer_pubkey: need.pubkey, thread_root: need.id, created_at: ev.created_at });
  }
  return out;
}

/** Kind-1 complaints in fixed format. threadDomain: 420 id -> store domain (from buys). Store keys never complain. */
export function deriveComplaints(notes: NostrEventLine[], threadDomain: Map<string, string>, storeKeys: Map<string, string>): Complaint[] {
  const out: Complaint[] = []; const seen = new Set<string>();
  for (const ev of notes) {
    if (ev.kind !== 1 || seen.has(ev.id) || !verifyNostrEvent(ev as RawLine, 1).ok) continue;
    const t = (n: string) => ev.tags.filter((x) => x[0] === n);
    const flag = t("km-complaint"), ds = t("d-store"), root = t("e").filter((x) => x[3] === "root");
    if (flag.length !== 1 || flag[0]![1] !== "1" || ds.length !== 1 || root.length !== 1) continue;
    const d = ds[0]![1]!, r = root[0]![1]!;
    if (threadDomain.get(r) !== d || storeKeys.get(ev.pubkey) === d) continue;
    seen.add(ev.id);
    out.push({ event_id: ev.id, store_domain: d, author_pubkey: ev.pubkey, thread_root: r, created_at: ev.created_at });
  }
  return out;
}

// ---------------- graph (relay reads, injectable) ----------------
export type RelayQuery = (filter: Record<string, unknown>) => Promise<NostrEventLine[]>;
export interface Graph { hash: string; seed: string; hop1: number; members: Map<string, 0 | 1 | 2> }
const validContacts = (evs: NostrEventLine[], authors: Set<string>) => {
  const latest = new Map<string, NostrEventLine>();
  for (const e of evs) if (e.kind === 3 && authors.has(e.pubkey) && verifyNostrEvent(e as RawLine, 3).ok) { const p = latest.get(e.pubkey); if (!p || e.created_at > p.created_at) latest.set(e.pubkey, e); }
  return latest;
};
const pTags = (e: NostrEventLine) => e.tags.filter((t) => t[0] === "p" && HEX64.test(t[1] ?? "")).map((t) => t[1]!);
export const MAX_HOP1 = 5000;

/** Membership of `candidates` in seed + 2 hops. Kind 3 is replaceable, so a relay returns each author's latest list;
 * the hop-2 query asks only for hop-1 lists that p-tag a candidate (the relay filters, so the graph is never downloaded). */
export async function buildGraph(seed: string, candidates: string[], q: RelayQuery): Promise<Graph> {
  const s1 = validContacts(await q({ kinds: [3], authors: [seed], limit: 1 }), new Set([seed])).get(seed);
  const hop1 = new Set(s1 ? pTags(s1).slice(0, MAX_HOP1) : []); hop1.delete(seed);
  const members = new Map<string, 0 | 1 | 2>([[seed, 0]]);
  const cand = [...new Set(candidates.filter((c) => HEX64.test(c)))];
  for (const c of cand) if (hop1.has(c)) members.set(c, 1);
  const rest = cand.filter((c) => !members.has(c));
  const h1 = [...hop1];
  for (let i = 0; i < h1.length && rest.length; i += 500) for (let j = 0; j < rest.length; j += 200) {
    const lists = validContacts(await q({ kinds: [3], authors: h1.slice(i, i + 500), "#p": rest.slice(j, j + 200) }), new Set(h1.slice(i, i + 500)));
    for (const e of lists.values()) for (const p of pTags(e)) if (rest.includes(p) && !members.has(p)) members.set(p, 2);
  }
  const hash = bytesToHex(sha256(utf8ToBytes(canonicalJson({ seed, hop1: [...hop1].sort(), members: [...members].sort() }))));
  return { hash, seed, hop1: hop1.size, members };
}

/** One relay REQ over the existing Connect (wss), bounded by EOSE or a timeout. Our own relay only (KM_TRUST_RELAY). */
export function relayQuery(url: string, connect: Connect, timeoutMs = 20_000, maxEvents = 5000): RelayQuery {
  return async (filter) => {
    const ws = await connect(url); const out: NostrEventLine[] = []; const sub = "km-trust";
    return await new Promise<NostrEventLine[]>((resolve) => {
      const done = () => { try { ws.send(JSON.stringify(["CLOSE", sub])); ws.close(); } catch { /* */ } resolve(out); };
      const timer = setTimeout(done, timeoutMs);
      ws.addEventListener("message", (e) => {
        try { const m = JSON.parse(String(e.data)) as unknown[];
          if (m[0] === "EVENT" && m[1] === sub && out.length < maxEvents) out.push(m[2] as NostrEventLine);
          if (m[0] === "EOSE" || m[0] === "CLOSED") { clearTimeout(timer); done(); }
        } catch { /* ignore */ }
      });
      ws.addEventListener("close", () => { clearTimeout(timer); resolve(out); });
      ws.send(JSON.stringify(["REQ", sub, filter]));
    });
  };
}

// ---------------- daily job (writes, append-only) ----------------
type JobEnv = { DB?: D1Database; KM_TRUST_BUYS?: string; KM_TRUST_SEED_NPUB?: string; KM_TRUST_RELAY?: string };
export async function runTrustJob(env: JobEnv, q: RelayQuery | null, nowS: number): Promise<{ ran: boolean; why?: string; buys?: number; complaints?: number; members?: number }> {
  if (!trustBuysEnabled(env)) return { ran: false, why: "KM_TRUST_BUYS off" };
  const seed = npubToHex(env.KM_TRUST_SEED_NPUB);
  if (!seed) return { ran: false, why: "no valid KM_TRUST_SEED_NPUB" };
  if (!env.DB || !q) return { ran: false, why: "no db or relay" };
  const db = env.DB;
  const claims = (await db.prepare("SELECT domain, pubkey FROM store_claims WHERE status = 'active'").all<{ domain: string; pubkey: string }>()).results ?? [];
  const storeKeys = new Map(claims.map((c) => [c.pubkey.toLowerCase(), c.domain]));
  const evRows = (await db.prepare(`SELECT raw_json FROM nostr_events WHERE kind IN (420,421,422) AND ${visibleSql("nostr_events")} ORDER BY created_at DESC LIMIT 5000`).all<{ raw_json: string }>()).results ?? [];
  // nostr_events rows were signature-checked at ingest (relay-ingest.ts); skip re-verifying to stay inside cron CPU limits.
  const buys = deriveBuys(evRows.map((r) => JSON.parse(r.raw_json) as NostrEventLine), storeKeys, { checkSig: false });
  const threadDomain = new Map(buys.map((b) => [b.thread_root, b.store_domain]));
  const roots = [...threadDomain.keys()]; let notes: NostrEventLine[] = [];
  for (let i = 0; i < roots.length; i += 200) notes = notes.concat(await q({ kinds: [1], "#e": roots.slice(i, i + 200) }));
  const complaints = deriveComplaints(notes, threadDomain, storeKeys);
  const g = await buildGraph(seed, [...buys.map((b) => b.buyer_pubkey), ...complaints.map((c) => c.author_pubkey)], q);
  const st: D1PreparedStatement[] = [
    ...buys.map((b) => db.prepare("INSERT OR IGNORE INTO trust_buys (event_id, store_domain, buyer_pubkey, thread_root, created_at) VALUES (?,?,?,?,?)").bind(b.event_id, b.store_domain, b.buyer_pubkey, b.thread_root, b.created_at)),
    ...complaints.map((c) => db.prepare("INSERT OR IGNORE INTO trust_complaints (event_id, store_domain, author_pubkey, thread_root, created_at) VALUES (?,?,?,?,?)").bind(c.event_id, c.store_domain, c.author_pubkey, c.thread_root, c.created_at)),
    ...[...g.members].map(([pk, hop]) => db.prepare("INSERT OR IGNORE INTO trust_graph_members (graph_hash, pubkey, hop) VALUES (?,?,?)").bind(g.hash, pk, hop)),
    db.prepare("INSERT OR IGNORE INTO trust_graph_heads (graph_hash, seed, hop1_count, members, built_at) VALUES (?,?,?,?,?)").bind(g.hash, seed, g.hop1, g.members.size, nowS),
  ];
  for (let i = 0; i < st.length; i += 50) await db.batch(st.slice(i, i + 50));
  return { ran: true, buys: buys.length, complaints: complaints.length, members: g.members.size };
}

// ---------------- read side ----------------
let cache: { at: number; key: string; map: Map<string, TrustField> } | null = null;
export const TIER_CACHE_S = 3600;
export function resetTierCache() { cache = null; }
type ReadEnv = { DB?: D1Database; KM_TRUST_LABELS?: string; KM_TRUST_BUYS?: string; KM_TRUST_SEED_NPUB?: string };
/** Tier per domain (cached per isolate for an hour: a few aggregate reads, not per row). Unknown domain -> DEFAULT_TRUST. */
export async function loadTiers(env: ReadEnv, nowS: number): Promise<Map<string, TrustField> | null> {
  if (!trustLabelsEnabled(env) || !env.DB) return null;
  const key = `${env.KM_TRUST_BUYS ?? ""}|${env.KM_TRUST_SEED_NPUB ?? ""}`;
  if (cache && cache.key === key && nowS - cache.at < TIER_CACHE_S) return cache.map;
  const db = env.DB; const map = new Map<string, TrustField>();
  const fs = new Map<string, number>(), rg = new Map<string, number>();
  try {
    const obs = (await db.prepare("SELECT domain, signal, value_json FROM store_trust_obs WHERE signal IN ('first_seen','domain_registered') AND value_json != 'null'").all<{ domain: string; signal: string; value_json: string }>()).results ?? [];
    for (const o of obs) {
      const v = JSON.parse(o.value_json) as { at?: string; registered?: string };
      const t = Date.parse(o.signal === "first_seen" ? v.at ?? "" : (v.registered ?? "") + "T00:00:00Z") / 1000;
      if (!Number.isFinite(t)) continue;
      const m = o.signal === "first_seen" ? fs : rg; m.set(o.domain, Math.min(m.get(o.domain) ?? Infinity, t));
    }
  } catch { /* table missing: everything unknown */ }
  const seed = trustBuysEnabled(env) ? npubToHex(env.KM_TRUST_SEED_NPUB) : null;
  let gh: string | null = null; const buyers = new Map<string, number>(), compl = new Map<string, number>();
  if (seed) {
    try {
      gh = (await db.prepare("SELECT graph_hash FROM trust_graph_heads WHERE seed = ? ORDER BY built_at DESC LIMIT 1").bind(seed).first<{ graph_hash: string }>())?.graph_hash ?? null;
      if (gh) {
        for (const r of (await db.prepare("SELECT b.store_domain AS d, COUNT(DISTINCT b.buyer_pubkey) AS n FROM trust_buys b JOIN trust_graph_members m ON m.graph_hash = ? AND m.pubkey = b.buyer_pubkey GROUP BY b.store_domain").bind(gh).all<{ d: string; n: number }>()).results ?? []) buyers.set(r.d, r.n);
        for (const r of (await db.prepare("SELECT c.store_domain AS d, COUNT(*) AS n FROM trust_complaints c JOIN trust_graph_members m ON m.graph_hash = ? AND m.pubkey = c.author_pubkey LEFT JOIN trust_dismissals x ON x.event_id = c.event_id WHERE x.event_id IS NULL GROUP BY c.store_domain").bind(gh).all<{ d: string; n: number }>()).results ?? []) compl.set(r.d, r.n);
      }
    } catch { gh = null; }
  }
  for (const d of new Set([...fs.keys(), ...rg.keys(), ...buyers.keys(), ...compl.keys()]))
    map.set(d, tierFor({ firstSeenAt: fs.get(d) ?? null, registeredAt: rg.get(d) ?? null, buyers: gh ? buyers.get(d) ?? 0 : null, complaints: gh ? compl.get(d) ?? 0 : null, graphHash: gh, nowS }));
  cache = { at: nowS, key, map };
  return map;
}
