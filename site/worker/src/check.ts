import type { Snapshot } from "./index-mem";
import { parseRaw, rowToCompact } from "./records-api";
import { checkExtras, checkoutOf } from "./explain";

export type Verdict = "reachable" | "agents-not-welcome" | "blocked-tos" | "error" | "not-in-index";

export function normalizeDomainInput(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "");
  if (!/^[a-z0-9.-]{1,253}$/.test(s) || !s.includes(".")) return null;
  return s;
}

/** Index-only lookup. Never triggers a live crawl. */
export function checkDomain(snap: Snapshot, input: string, origin: string): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  const d = normalizeDomainInput(input);
  if (!d) return { ok: false, message: "domain must be a hostname like example.com" };
  const candidates = [d, d.startsWith("www.") ? d.slice(4) : `www.${d}`];
  const row = snap.rows.find((r) => candidates.includes(r.d));
  if (!row) {
    return { ok: true, body: { domain: d, verdict: "not-in-index", message: "not in index yet", live_crawl: false, suggest: "https://github.com/FloppyKit/klickymart/issues/new?template=suggest-site.yml" } };
  }
  const raw = parseRaw(row.raw_json);
  const c = rowToCompact(row, origin) as unknown as { pay: { online: string[]; instore: string[]; unscoped: string[] } };
  const verdict: Verdict = row.status === "crawled" ? "reachable" : (row.status as Verdict);
  const evu = Array.isArray(raw.evu) ? (raw.evu as string[]) : [];
  const anw = raw.anw as { url?: string } | null | undefined;
  const evidence = evu[0] ?? anw?.url ?? (typeof raw.tos_url === "string" ? raw.tos_url : null);
  return {
    ok: true,
    body: {
      domain: row.d,
      verdict,
      status: row.status,
      ...checkExtras(row, raw),
      checkout_depth: checkoutOf(row, raw),
      pay: c.pay,
      btc_grade: row.btc,
      btc_any: row.btc_any === null ? null : row.btc_any === 1,
      record_ts: row.ts,
      record_time: new Date(row.ts * 1000).toISOString(),
      evidence,
      record: `${origin}/records/${encodeURIComponent(row.d)}`,
      live_crawl: false,
    },
  };
}
