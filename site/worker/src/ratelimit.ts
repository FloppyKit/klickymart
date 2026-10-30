/** KM-008: atomic rate limits on D1. take() increments a counter only while it is below the limit, in one SQL statement
 * (INSERT .. ON CONFLICT DO UPDATE .. WHERE n < limit RETURNING n). D1 runs statements one at a time per database, so
 * N parallel requests get exactly `limit` successes. Keys must embed their window (day, hour, ...). */
export interface Limit { k: string; limit: number; ttlS: number }

export async function take(db: D1Database, l: Limit, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (l.limit <= 0) return false;
  const r = await db.prepare("INSERT INTO rate_limits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 WHERE rate_limits.n < ? RETURNING n")
    .bind(l.k, nowS + l.ttlS, l.limit).first<{ n: number }>();
  if (Math.random() < 0.01) { try { await db.prepare("DELETE FROM rate_limits WHERE exp < ?").bind(nowS).run(); } catch { /* */ } }
  return !!r;
}

/** Take every limit in order; returns the first limit that refused, or null when all were granted. A refusal does not
 * refund earlier takes (fail closed). */
export async function takeAll(db: D1Database, limits: Limit[], nowS = Math.floor(Date.now() / 1000)): Promise<Limit | null> {
  for (const l of limits) if (!(await take(db, l, nowS))) return l;
  return null;
}
export const utcDayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
