import { visibleSql } from "./takedown";
/** KM-007: key age is when KlickyMart first saw a key (ingest time), never an author-set created_at, so a backdated
 * note or kind 0 cannot make a fresh key look old. Day-granular sources (received_day) count from the END of that UTC
 * day, so they never make a key look older than it is. */
export const MIN_RANK_KEY_AGE_S = 7 * 86400;
/** D1 caps bound parameters per statement at 100; leave room for none else in these queries. */
export const KEY_FIRST_SEEN_CHUNK = 90;
/** First-seen time for exactly the given keys (same values the old whole-table GROUP BY gave for those keys). Scoped by
 * `pubkey IN (...)` so the per-request cost follows the keys on the page, served by i_ne_pk / i_exp_pk / i_reviews_pk_day,
 * instead of aggregating every row of nostr_events, experiences and reviews (2026-11-01 D1 read spike). Empty input
 * returns an empty map without touching the DB. */
export async function keyFirstSeen(db: D1Database, pubkeys: Iterable<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys = [...new Set(pubkeys)];
  if (!keys.length) return out;
  const qs = [
    (ph: string) => `SELECT pubkey, MIN(first_seen) AS t FROM nostr_events WHERE pubkey IN (${ph}) AND ${visibleSql("nostr_events")} GROUP BY pubkey`,
    (ph: string) => `SELECT pubkey, MIN(unixepoch(received_day)) + 86399 AS t FROM experiences WHERE pubkey IN (${ph}) AND ${visibleSql("experiences")} GROUP BY pubkey`,
    (ph: string) => `SELECT pubkey, MIN(unixepoch(received_day)) + 86399 AS t FROM reviews WHERE pubkey IN (${ph}) AND ${visibleSql("reviews")} GROUP BY pubkey`,
  ];
  for (let i = 0; i < keys.length; i += KEY_FIRST_SEEN_CHUNK) {
    const chunk = keys.slice(i, i + KEY_FIRST_SEEN_CHUNK); const ph = chunk.map(() => "?").join(",");
    for (const q of qs) {
      const { results } = await db.prepare(q(ph)).bind(...chunk).all<{ pubkey: string; t: number | null }>().catch(() => ({ results: [] as { pubkey: string; t: number | null }[] }));
      for (const r of results ?? []) if (typeof r.t === "number") out.set(r.pubkey, Math.min(out.get(r.pubkey) ?? Infinity, r.t));
    }
  }
  return out;
}
/** Rank status for one key, as loadAggregates() will see it once this note is stored: first-seen is the earliest of the
 * key's existing rows and the end of today's UTC day (the received_day this note gets). counts_after is when the key
 * clears MIN_RANK_KEY_AGE_S. */
export async function keyRankStatus(db: D1Database | undefined, pubkey: string, nowS: number, minAge = MIN_RANK_KEY_AGE_S): Promise<{ key_counts_now: boolean; counts_after: string }> {
  let t = Math.floor(nowS / 86400) * 86400 + 86399;
  if (db) {
    const qs = [
      `SELECT MIN(first_seen) AS t FROM nostr_events WHERE pubkey = ? AND ${visibleSql("nostr_events")}`,
      `SELECT MIN(unixepoch(received_day)) + 86399 AS t FROM experiences WHERE pubkey = ? AND ${visibleSql("experiences")}`,
      `SELECT MIN(unixepoch(received_day)) + 86399 AS t FROM reviews WHERE pubkey = ? AND ${visibleSql("reviews")}`,
    ];
    for (const q of qs) {
      const r = await db.prepare(q).bind(pubkey).first<{ t: number | null }>().catch(() => null);
      if (typeof r?.t === "number") t = Math.min(t, r.t);
    }
  }
  return { key_counts_now: nowS - t >= minAge, counts_after: new Date((t + minAge) * 1000).toISOString() };
}
/** A note counts toward rank only if its key is at least MIN_RANK_KEY_AGE_S old by ingest time. K10-001: no proof tier
 * bypasses this gate. A verified-preimage proof only shows an invoice signed by the store's declared node plus a matching
 * preimage, which the store owner can produce for any invoice without anyone paying; proofs add weight only AFTER the gate.
 * proofStatus is kept in the signature for callers; it no longer changes the result. */
export function countsForRank(pubkey: string, _proofStatus: string | null | undefined, seen: Map<string, number>, nowS: number, minAge = MIN_RANK_KEY_AGE_S): boolean {
  const t = seen.get(pubkey); return t !== undefined && nowS - t >= minAge;
}
