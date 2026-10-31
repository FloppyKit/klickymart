import { protocolsOf, PROTOCOLS_NOTE } from "./protocols";
import { anJson } from "./agent-native";
import { walletFacts, findRow } from "./store-card";
import { storeFacts } from "./explain";
import type { Snapshot } from "./index-mem";
import { parseRaw, rowToCompact } from "./records-api";
import { TRUST_SCOPE_NOTE } from "./submissions";
import { checkExtras, checkoutOf, deriveVerdict, checkoutKnown } from "./explain";

export type Verdict = "reachable" | "checkout-blocked" | "agents-not-welcome" | "blocked-tos" | "error" | "not-in-index";

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
  const row = snap.rows.find((r) => candidates.includes(r.d)) ?? findRow(snap, d);
  if (!row) {
    return { ok: true, body: { domain: d, verdict: "not-in-index", message: "not in index yet", live_crawl: false, suggest: "https://github.com/FloppyKit/klickymart/issues/new?template=suggest-site.yml" } };
  }
  const raw = parseRaw(row.raw_json);
  const c = rowToCompact(row, origin) as unknown as { pay: { online: string[]; instore: string[]; unscoped: string[] } };
  const dv = deriveVerdict(row, raw);
  const verdict: Verdict = dv.verdict;
  const evu = Array.isArray(raw.evu) ? (raw.evu as string[]) : [];
  const anw = raw.anw as { url?: string } | null | undefined;
  const evidence = evu[0] ?? anw?.url ?? (typeof raw.tos_url === "string" ? raw.tos_url : null);
  return {
    ok: true,
    body: {
      domain: row.d,
      ...(row.d !== d && row.d !== candidates[1] ? { requested: d, matched_via: `${d} -> ${row.d} (same registrable domain)` } : {}),
      ...(payNotObserved(raw) ? { pay_note: PAY_NOT_OBSERVED } : {}),
      verdict,
      pages_reachable: dv.pages_reachable,
      verdict_reason: dv.verdict_reason,
      checkout_known: checkoutKnown(row, raw), // false = the probe never established checkout depth (verdict covers pages only)
      primary_reason: dv.primary_reason,
      status: row.status,
      ...storeFacts(row),
      ...checkExtras(row, raw),
      checkout_depth: checkoutOf(row, raw),
      // steps = the step list the checkout probe walked (stage, url, action, status); steps_count = its length.
      steps: checkoutOf(row, raw).steps,
      steps_count: checkoutOf(row, raw).steps_count,
      pay: c.pay,
      ...walletFacts(raw, (c.pay as unknown as { all?: string[] }).all),
      btc_grade: row.btc,
      btc_any: row.btc_any === null ? null : row.btc_any === 1,
      btc_indirect: (raw.btc_indirect as unknown[] | undefined) ?? null,
      btc_grade_range: (raw.btc_grade_range as string | undefined) ?? null,
      btc_grade_reason: (raw.btc_grade_reason as string | undefined) ?? null,
      record_ts: row.ts,
      record_time: new Date(row.ts * 1000).toISOString(),
      evidence,
      record: `${origin}/records/${encodeURIComponent(row.d)}`,
      live_crawl: false,
      ...(anJson(row.d) ? { agent_native: anJson(row.d) } : {}),
      protocols: { ...protocolsOf(row.d, raw), note: PROTOCOLS_NOTE },
    },
  };
}

export const PAY_NOT_OBSERVED = "payment methods not observed: our crawl did not read this store's payment options (for example the checkout asks for an address before showing them). An empty pay list here means unknown, not none.";
/** Empty pay lists with no pay source = a data gap (not observed), as opposed to a store that lists no methods. */
export function payNotObserved(raw: Record<string, unknown>): boolean {
  const empty = (k: string) => !Array.isArray(raw[k]) || (raw[k] as unknown[]).length === 0;
  return empty("pay") && empty("pay_online") && empty("pay_instore") && empty("pay_unscoped") && !raw.pay_src;
}

/** /check trust: tier fields + trust_dimensions with checkout_accessible derived from the verdict and probe depth, plus the scope note. */
export function checkTrustFields(body: Record<string, unknown>, tf: Record<string, unknown>): Record<string, unknown> {
  const dims = { ...(tf.trust_dimensions as Record<string, unknown>) };
  const co = (body.checkout_depth as { co?: number | null } | undefined)?.co ?? null;
  const pr = (body.primary_reason as { source?: string } | undefined)?.source;
  dims.checkout_accessible = body.verdict !== "reachable" || pr === "terms" ? false : co === null ? null : co >= 2;
  return { ...tf, trust_dimensions: dims, trust_scope: TRUST_SCOPE_NOTE };
}
