/** M4 S3: trust observations (fixed format) and the live-search domain queue.
 * Observations come from crawler/trust_obs.py, which writes validated INSERT OR IGNORE SQL that the operator applies with
 * `wrangler d1 execute` (same operator pattern as the M3 key records); appendObs is the same validated insert for Worker
 * code and tests. KM_CRAWL_QUEUE (default OFF) records the DOMAIN ONLY of live Shopify Catalog results into live_seen_domains.
 * Nothing here ranks or hides anything (S4 owns that). */
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

const on = (v?: string) => { const s = (v ?? "").trim().toLowerCase(); return s === "1" || s === "true" || s === "on"; };
export const crawlQueueEnabled = (env: { KM_CRAWL_QUEUE?: string }) => on(env.KM_CRAWL_QUEUE);

export const SIGNALS = ["first_seen", "domain_registered", "return_policy", "contact", "reseller"] as const;
export const METHODS = ["own-ledger", "rdap", "shopify-policy-page", "contact-page", "products-json"] as const;
const NEEDS_QUOTE = new Set(["return_policy", "contact", "reseller"]);
export interface TrustObs { id: string; domain: string; signal: (typeof SIGNALS)[number]; value_json: string; evidence_url: string | null; quote: string | null; method: (typeof METHODS)[number]; observed_at: number }

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const normDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, "");
export const obsId = (domain: string, signal: string, valueJson: string) => bytesToHex(sha256(utf8ToBytes(`${domain}\u0000${signal}\u0000${valueJson}`)));

/** Validate one row; exact field set, recomputed id, quote + evidence rules. Same rules as crawler/trust_obs.py. */
export function validateObs(x: unknown): { ok: true; row: TrustObs } | { ok: false; error: string } {
  const KEYS = "domain,evidence_url,id,method,observed_at,quote,signal,value_json";
  if (!x || typeof x !== "object" || Object.keys(x).sort().join() !== KEYS) return { ok: false, error: `fields must be exactly ${KEYS}` };
  const r = x as TrustObs;
  if (typeof r.domain !== "string" || !DOMAIN.test(r.domain) || r.domain !== normDomain(r.domain)) return { ok: false, error: "bad domain" };
  if (!SIGNALS.includes(r.signal)) return { ok: false, error: "bad signal" };
  if (!METHODS.includes(r.method)) return { ok: false, error: "bad method" };
  if (!Number.isSafeInteger(r.observed_at) || r.observed_at < 1_600_000_000) return { ok: false, error: "bad observed_at" };
  let v: unknown; try { v = JSON.parse(r.value_json); } catch { return { ok: false, error: "value_json not JSON" }; }
  if (r.id !== obsId(r.domain, r.signal, r.value_json)) return { ok: false, error: "id mismatch" };
  if (v !== null) {
    if (r.method !== "own-ledger" && (typeof r.evidence_url !== "string" || !/^https:\/\//.test(r.evidence_url))) return { ok: false, error: "evidence_url required for a known value" };
    const quoted = r.signal === "reseller" ? Array.isArray((v as { signs?: unknown[] }).signs) && (v as { signs: unknown[] }).signs.length > 0 : NEEDS_QUOTE.has(r.signal);
    if (quoted && (typeof r.quote !== "string" || !r.quote.trim())) return { ok: false, error: "quote required" };
  }
  if (r.quote !== null && (typeof r.quote !== "string" || r.quote.length > 500)) return { ok: false, error: "quote must be ≤500 chars" };
  return { ok: true, row: r };
}

/** Append rows (INSERT OR IGNORE: identical value already stored = no-op). Returns inserted/rejected counts. */
export async function appendObs(db: D1Database, rows: unknown[]): Promise<{ inserted: number; rejected: { i: number; error: string }[] }> {
  const rejected: { i: number; error: string }[] = []; const stmts: D1PreparedStatement[] = [];
  rows.forEach((x, i) => {
    const v = validateObs(x);
    if (!v.ok) { rejected.push({ i, error: v.error }); return; }
    const r = v.row;
    stmts.push(db.prepare("INSERT OR IGNORE INTO store_trust_obs (id, domain, signal, value_json, evidence_url, quote, method, observed_at) VALUES (?,?,?,?,?,?,?,?)").bind(r.id, r.domain, r.signal, r.value_json, r.evidence_url, r.quote, r.method, r.observed_at));
  });
  let inserted = 0;
  for (let i = 0; i < stmts.length; i += 50) for (const res of await db.batch(stmts.slice(i, i + 50))) inserted += res.meta.changes ?? 0;
  return { inserted, rejected };
}

/** Max new queue rows per UTC day (writes budget; well under 50% of D1's 100k/day). */
export const QUEUE_DAILY_CAP = 500;
/** Queue the domains (only) of live results. Never stores anything else from a result. Best-effort: errors are swallowed. */
export async function queueDomains(env: { DB?: D1Database; KM_CRAWL_QUEUE?: string }, domains: (string | null | undefined)[], nowS: number): Promise<number> {
  if (!crawlQueueEnabled(env) || !env.DB) return 0;
  const ds = [...new Set(domains.filter((d): d is string => typeof d === "string").map(normDomain).filter((d) => DOMAIN.test(d)))].slice(0, 50);
  if (!ds.length) return 0;
  try {
    const day0 = nowS - (nowS % 86400);
    const today = (await env.DB.prepare("SELECT COUNT(*) AS c FROM live_seen_domains WHERE first_seen_at >= ?").bind(day0).first<{ c: number }>())?.c ?? 0;
    const room = Math.max(0, QUEUE_DAILY_CAP - today);
    if (!room) return 0;
    let n = 0;
    for (const res of await env.DB.batch(ds.slice(0, room).map((d) => env.DB!.prepare("INSERT OR IGNORE INTO live_seen_domains (domain, first_seen_at, source) VALUES (?,?,'live-catalog')").bind(d, nowS)))) n += res.meta.changes ?? 0;
    return n;
  } catch { return 0; }
}
