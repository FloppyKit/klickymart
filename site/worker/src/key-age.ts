/** KM-007: key age is when KlickyMart first saw a key (ingest time), never an author-set created_at, so a backdated
 * note or kind 0 cannot make a fresh key look old. Day-granular sources (received_day) count from the END of that UTC
 * day, so they never make a key look older than it is. */
export const MIN_RANK_KEY_AGE_S = 7 * 86400;
export async function keyFirstSeen(db: D1Database): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const qs = [
    "SELECT pubkey, MIN(first_seen) AS t FROM nostr_events GROUP BY pubkey",
    "SELECT pubkey, MIN(unixepoch(received_day)) + 86399 AS t FROM experiences GROUP BY pubkey",
    "SELECT pubkey, MIN(unixepoch(received_day)) + 86399 AS t FROM reviews GROUP BY pubkey",
  ];
  for (const q of qs) {
    const { results } = await db.prepare(q).all<{ pubkey: string; t: number | null }>().catch(() => ({ results: [] as { pubkey: string; t: number | null }[] }));
    for (const r of results ?? []) if (typeof r.t === "number") out.set(r.pubkey, Math.min(out.get(r.pubkey) ?? Infinity, r.t));
  }
  return out;
}
/** A note counts toward rank only if its key is at least MIN_RANK_KEY_AGE_S old by ingest time, or the note carries a
 * payment proof KlickyMart checked (proof_status verified*, bound first-use-wins per R6-001), which costs real money. */
export function countsForRank(pubkey: string, proofStatus: string | null | undefined, seen: Map<string, number>, nowS: number, minAge = MIN_RANK_KEY_AGE_S): boolean {
  if (proofStatus?.startsWith("verified")) return true;
  const t = seen.get(pubkey); return t !== undefined && nowS - t >= minAge;
}
