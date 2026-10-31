/** PQ-4: per-key daily allowance for new pending-crawl entries. Same rule for every key; it grows with
 * (a) tenure: how long KlickyMart has seen the key (ingest time, see key-age.ts; never author-set created_at), and
 * (b) confirmed sales: the key's own kind 422 notes with attempt "paid" that carry no flag.
 * It is NOT a vote: reviews of the key, ratings, tips/zaps received never raise it. Any active flag on any of the
 * key's notes (incl. corroborated NIP-56 community reports) drops it back to base. The per-IP and global caps
 * (PENDING_LIMITS) still apply on top; the global cap is the backstop. */
export const PENDING_KEY_ALLOWANCE = {
  /** every key, including unknown ones */
  base: 5,
  /** added per completed (attempt=paid), unflagged 422 by this key */
  perConfirmedSale: 5,
  /** tenure multipliers applied to (base + sales bonus); the highest tier reached wins */
  tenure: [{ minDays: 30, mult: 4 }, { minDays: 7, mult: 2 }] as const,
  /** hard per-key ceiling so one key cannot use up the global daily budget (200) */
  ceiling: 100,
} as const;

export interface KeyRecord {
  /** unix seconds KlickyMart first saw the key; undefined if never seen */
  firstSeenS?: number;
  /** completed (attempt=paid) 422 notes by this key with no flag */
  confirmedSales: number;
  /** true if any of the key's notes has an active flag */
  flagged: boolean;
}

export function pendingKeyAllowance(rec: KeyRecord, nowS: number, c = PENDING_KEY_ALLOWANCE): number {
  if (rec.flagged) return c.base;
  const sales = Math.max(0, Math.floor(rec.confirmedSales || 0));
  const days = rec.firstSeenS === undefined ? 0 : Math.max(0, (nowS - rec.firstSeenS) / 86400);
  const mult = c.tenure.find((t) => days >= t.minDays)?.mult ?? 1;
  return Math.min(c.ceiling, (c.base + c.perConfirmedSale * sales) * mult);
}

/** Loads the key's record from D1 (reviews, note_flags, ingest first-seen). Any failure falls back to base. */
export async function loadKeyRecord(db: D1Database | undefined, pubkey: string): Promise<KeyRecord> {
  if (!db) return { confirmedSales: 0, flagged: false };
  try {
    const flag = await db.prepare("SELECT 1 AS x FROM note_flags WHERE pubkey = ? LIMIT 1").bind(pubkey).first<{ x: number }>();
    if (flag) return { confirmedSales: 0, flagged: true };
    const sales = await db.prepare("SELECT COUNT(*) AS n FROM reviews r WHERE r.pubkey = ? AND r.attempt = 'paid' AND NOT EXISTS (SELECT 1 FROM note_flags f WHERE f.id = r.id)").bind(pubkey).first<{ n: number }>();
    const fs = await db.prepare(`SELECT MIN(t) AS t FROM (
      SELECT MIN(first_seen) AS t FROM nostr_events WHERE pubkey = ?1
      UNION ALL SELECT MIN(unixepoch(received_day)) + 86399 FROM experiences WHERE pubkey = ?1
      UNION ALL SELECT MIN(unixepoch(received_day)) + 86399 FROM reviews WHERE pubkey = ?1)`).bind(pubkey).first<{ t: number | null }>();
    return { confirmedSales: Number(sales?.n ?? 0) || 0, flagged: false, ...(typeof fs?.t === "number" ? { firstSeenS: fs.t } : {}) };
  } catch { return { confirmedSales: 0, flagged: false }; }
}
