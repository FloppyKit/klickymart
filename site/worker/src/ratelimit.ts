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

/** Give back one unit taken by take() (never below zero). */
export async function give(db: D1Database, l: Limit): Promise<void> {
  await db.prepare("UPDATE rate_limits SET n = n - 1 WHERE k = ? AND n > 0").bind(l.k).run();
}

/** Take every limit in order; returns the first limit that refused, or null when all were granted.
 * R5-002/R5-003: on a refusal the earlier takes are given back, so a request refused by a narrow (per-key, per-ip) limit
 * cannot drain a shared (global) one. Callers still list the most specific limit first. */
export async function takeAll(db: D1Database, limits: Limit[], nowS = Math.floor(Date.now() / 1000)): Promise<Limit | null> {
  const got: Limit[] = [];
  for (const l of limits) {
    if (!(await take(db, l, nowS))) { for (const g of got.reverse()) { try { await give(db, g); } catch { /* best effort */ } } return l; }
    got.push(l);
  }
  return null;
}
export const utcDayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
