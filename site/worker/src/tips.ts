/** Tips on 422 reviews / shopping-experience notes: NIP-57 zap receipts (kind 9735) whose `e` tag points at a note.
 * Display counts every receipt; ranking weight counts only DISTINCT tippers with a validated receipt, ignores self-zaps,
 * and is capped (see TIP_WEIGHT). Read-only over nostr_events; nothing is published. */
import { decodeBolt11 } from "./bolt11";
import { cachedZapKey, checkZapReceipt, lud16Of } from "./pay-binding";
import { verifyNostrEvent } from "./nostr-verify";

export const ZAP_RECEIPT = 9735;
/** Ranking multiplier for a note: 1 + min(CAP, PER * distinct validated tippers). */
export const TIP_WEIGHT = { PER: 0.1, CAP: 0.5 };
/** A tipper counts toward the bonus only with a zap of at least MIN_SATS and a key with history: a visit note, other
 * public activity we hold, or first seen at least MIN_AGE_S ago. Dust and throwaway keys still show, but add nothing. */
export const TIP_BONUS_RULES = { MIN_SATS: 21, MIN_AGE_S: 30 * 86400 };
export const tipWeight = (distinctValidated: number) => 1 + Math.min(TIP_WEIGHT.CAP, TIP_WEIGHT.PER * distinctValidated);

type Ev = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
export interface Tip { receipt: string; target: string; tipper: string | null; sats: number | null; validated: boolean; self: boolean; created_at: number; eligible?: boolean }
export interface TipSummary { tips: number; sats: number; distinct_tippers: number; validated_tippers: number; bonus_tippers: number; self_zaps_ignored: number; weight: number }

/** One receipt -> tip. tipper = pubkey of the embedded 9734 zap request (the payer). validated (KM-003) = NIP-57 binding:
 * the receipt is signed by the nostrPubkey of the zapped author's LNURL (lud16) endpoint, the BOLT11 node signature and
 * description_hash check, and the amount matches the request. Without a known author zap key nothing validates. */
/** R12-002: the receipt must pay the note's author: the receipt's single p, the embedded 9734's single p and the note
 * author must match, and the 9734's e must be the tipped note. The receipt must be signed by the author's own LNURL
 * nostrPubkey, and that key must be proven to serve only one receiver (GP-2: unknown or custodial keys never validate), because anyone could
 * zap their own wallet behind the same key and credit someone else's note. */
/** GP-2 (R12-002 residual): fail closed on shared custodial zapper keys. Custodians (Primal, Wallet of Satoshi, Alby
 * custodial, Minibits, ...) sign every user's receipts with one zapper key, so an attacker on the same custodian can
 * self-zap with p=victim. A receipt only earns weight when its zapper key is PROVEN to serve exactly one receiver
 * (see loadTips); deny-listed keys and keys we cannot prove are single-receiver get weight 0.
 * TODO: add the real custodial zapper / LNURL nostrPubkey hex keys here once verified from the custodians' live
 * LNURL endpoints (none are recorded in this repo yet). Until then add them at deploy time via the
 * CUSTODIAL_ZAPPER_KEYS env var (comma-separated 64-hex). */
export const CUSTODIAL_ZAPPER_KEYS: readonly string[] = [];
/** Lightning-address domains run by custodians that sign all users' zaps with one shared key. */
export const CUSTODIAL_LUD16_DOMAINS: readonly string[] = ["primal.net", "walletofsatoshi.com", "getalby.com", "minibits.cash"];
let envDeny = new Set<string>();
/** Set from env.CUSTODIAL_ZAPPER_KEYS (comma-separated 64-hex); invalid entries are ignored. */
export function setCustodialZapperKeys(raw: string | undefined | null): void {
  envDeny = new Set((raw ?? "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^[0-9a-f]{64}$/.test(x)));
}
export const custodialZapperKey = (zk: string) => { const k = zk.toLowerCase(); return CUSTODIAL_ZAPPER_KEYS.includes(k) || envDeny.has(k); };
export const custodialLud16 = (lud16: string | null | undefined) => { const d = (lud16 ?? "").toLowerCase().split("@")[1] ?? ""; return CUSTODIAL_LUD16_DOMAINS.some((c) => d === c || d.endsWith("." + c)); };

const onlyTag = (tags: unknown, k: string): string | null => {
  if (!Array.isArray(tags)) return null;
  const v = tags.filter((t) => Array.isArray(t) && t[0] === k).map((t) => (t as unknown[])[1]);
  return v.length === 1 && typeof v[0] === "string" ? v[0] : null;
};
export function parseTip(r: Ev, authorOf: (id: string) => string | undefined, zapKeyOf: (author: string) => string | null | undefined = () => null, singleReceiver: (zk: string) => boolean = () => false): Tip | null {
  const target = r.tags.find((t) => t[0] === "e")?.[1];
  if (!target) return null;
  const b = r.tags.find((t) => t[0] === "bolt11")?.[1];
  const dec = b ? decodeBolt11(b) : null;
  let req: Ev | null = null;
  try { req = JSON.parse(r.tags.find((t) => t[0] === "description")?.[1] ?? "null") as Ev | null; } catch { req = null; }
  const tipper = req?.pubkey ?? r.tags.find((t) => t[0] === "P")?.[1] ?? null;
  const author = authorOf(target);
  const zk = author ? zapKeyOf(author) : null;
  const bound = !!author && onlyTag(r.tags, "p") === author && !!req && onlyTag(req.tags, "p") === author && onlyTag(req.tags, "e") === target;
  const validated = bound && !!zk && !custodialZapperKey(zk) && singleReceiver(zk) && checkZapReceipt(r, zk).ok;
  return { receipt: r.id, target, tipper, sats: dec?.amount_msat != null ? Math.floor(dec.amount_msat / 1000) : null, validated, self: !!tipper && !!author && tipper === author, created_at: r.created_at };
}

export const bonusEligible = (t: Tip) => !t.self && t.validated && !!t.tipper && (t.sats ?? 0) >= TIP_BONUS_RULES.MIN_SATS && t.eligible !== false;
export function summarize(tips: Tip[]): TipSummary {
  const nonSelf = tips.filter((t) => !t.self);
  const distinct = new Set(nonSelf.map((t) => t.tipper ?? t.receipt));
  const validated = new Set(nonSelf.filter((t) => t.validated && t.tipper).map((t) => t.tipper!));
  const bonus = new Set(nonSelf.filter((t) => bonusEligible(t)).map((t) => t.tipper!));
  return { tips: nonSelf.length, sats: nonSelf.reduce((a, t) => a + (t.sats ?? 0), 0), distinct_tippers: distinct.size, validated_tippers: validated.size, bonus_tippers: bonus.size,
    self_zaps_ignored: tips.length - nonSelf.length, weight: tipWeight(bonus.size) };
}

/** All tips on notes (optionally only notes about domain d), keyed by note id, plus per-reviewer and per-tipper (curator) views. */
export async function loadTips(db: D1Database | undefined, d?: string): Promise<{ byNote: Map<string, Tip[]>; author: Map<string, string>; noteDomain: Map<string, string> }> {
  const byNote = new Map<string, Tip[]>(); const author = new Map<string, string>(); const noteDomain = new Map<string, string>();
  if (!db) return { byNote, author, noteDomain };
  try {
    const notes = await db.prepare(`SELECT id, pubkey, d FROM experiences${d ? " WHERE d = ?" : ""}`).bind(...(d ? [d] : [])).all<{ id: string; pubkey: string; d: string }>();
    for (const n of notes.results ?? []) { author.set(n.id, n.pubkey); noteDomain.set(n.id, n.d); }
    const rv = await db.prepare(`SELECT id, pubkey, d FROM reviews${d ? " WHERE d = ?" : ""}`).bind(...(d ? [d] : [])).all<{ id: string; pubkey: string; d: string }>();
    for (const n of rv.results ?? []) { author.set(n.id, n.pubkey); noteDomain.set(n.id, n.d); }
    if (!author.size) return { byNote, author, noteDomain };
    const { results } = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = ?").bind(ZAP_RECEIPT).all<{ raw_json: string }>();
    // key history for the bonus rule: a visit note, other activity (not reports/receipts), or old enough
    const hist = new Set<string>();
    const nowS = Math.floor(Date.now() / 1000);
    // KM-003: notes and profiles are mintable by throwaway keys, so only ingest-time key age counts as history.
    for (const q of [
      // KM-003/KM-007: key age is when KlickyMart first saw the key (first_seen), not an author-set created_at.
      db.prepare("SELECT pubkey FROM nostr_events GROUP BY pubkey HAVING MIN(first_seen) <= ?").bind(nowS - TIP_BONUS_RULES.MIN_AGE_S)])
      for (const r of (await q.all<{ pubkey: string }>()).results ?? []) hist.add(r.pubkey);
    const zapKeys = new Map<string, string | null>();
    for (const a of new Set(author.values())) zapKeys.set(a, await cachedZapKey(db, await lud16Of(db, a)));
    // R12-002 / GP-2: fail closed. A zap key counts only when it is PROVEN to serve one receiver: exactly one author in
    // scope declares it, every lnurl_cache row for it names the same single lud16, that lud16 is not on a custodial
    // domain, and the key is not deny-listed. Unknown (no cache rows, cache missing) means weight 0.
    const keyUsers = new Map<string, number>(); const authorLud = new Map<string, string | null>();
    for (const a of new Set(author.values())) authorLud.set(a, await lud16Of(db, a));
    for (const k of zapKeys.values()) if (k) keyUsers.set(k, (keyUsers.get(k) ?? 0) + 1);
    const keyLuds = new Map<string, Set<string>>();
    try {
      for (const r of (await db.prepare("SELECT DISTINCT nostr_pubkey AS k, lud16 AS l FROM lnurl_cache WHERE nostr_pubkey IS NOT NULL").all<{ k: string; l: string }>()).results ?? [])
        (keyLuds.get(r.k) ?? keyLuds.set(r.k, new Set()).get(r.k)!).add(String(r.l).toLowerCase());
    } catch { /* cache table pending: nothing is proven */ }
    const keyAuthorLud = new Map<string, string | null>();
    for (const [a, k] of zapKeys) if (k) keyAuthorLud.set(k, authorLud.get(a) ?? null);
    const single = (zk: string) => {
      if (custodialZapperKey(zk) || keyUsers.get(zk) !== 1) return false;
      const luds = keyLuds.get(zk); const mine = keyAuthorLud.get(zk);
      return !!luds && luds.size === 1 && !!mine && luds.has(mine.toLowerCase()) && !custodialLud16(mine);
    };
    for (const row of results ?? []) {
      const t = parseTip(JSON.parse(row.raw_json) as Ev, (id) => author.get(id), (a) => zapKeys.get(a), single);
      if (!t || !author.has(t.target)) continue;
      t.eligible = !!t.tipper && hist.has(t.tipper);
      (byNote.get(t.target) ?? byNote.set(t.target, []).get(t.target)!).push(t);
    }
  } catch { /* migration pending */ }
  return { byNote, author, noteDomain };
}

export function perReviewer(t: Awaited<ReturnType<typeof loadTips>>) {
  const by = new Map<string, Tip[]>();
  for (const [id, tips] of t.byNote) { const a = t.author.get(id)!; (by.get(a) ?? by.set(a, []).get(a)!).push(...tips); }
  return [...by].map(([pubkey, tips]) => ({ reviewer: pubkey, notes_tipped: new Set(tips.map((x) => x.target)).size, ...summarize(tips) })).sort((a, b) => b.sats - a.sats);
}

/** Curator record: per tipper, which notes they tipped and how much (public data from the receipts). Self-zaps excluded. */
export function curators(t: Awaited<ReturnType<typeof loadTips>>) {
  const by = new Map<string, Tip[]>();
  for (const tips of t.byNote.values()) for (const x of tips) if (!x.self && x.tipper) (by.get(x.tipper) ?? by.set(x.tipper, []).get(x.tipper)!).push(x);
  return [...by].map(([tipper, tips]) => ({ tipper, tips: tips.length, sats: tips.reduce((a, x) => a + (x.sats ?? 0), 0), validated: tips.every((x) => x.validated),
    notes: [...new Set(tips.map((x) => x.target))].map((id) => ({ id, d: t.noteDomain.get(id) ?? null })) })).sort((a, b) => b.sats - a.sats);
}
