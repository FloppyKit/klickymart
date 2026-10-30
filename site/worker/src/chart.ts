/** Store chart: ranks on community aggregates (shopping-experience notes from Nostr) when a store has corroborated
 * community data (2+ keys), otherwise falls back to KlickyMart's crawl. Every value says which source it came from. */
import type { Snapshot } from "./index-mem";
import { parseRaw } from "./records-api";
import type { StoreAggregate } from "./experience";
import { MIN_KEYS } from "./experience";

export interface ChartRow {
  rank: number; d: string; score: number; score_source: "community" | "crawl";
  values: Record<string, { value: unknown; source: "community" | "crawl"; note?: string }>;
  community: StoreAggregate | null;
}
export function buildChart(snap: Snapshot, aggs: Map<string, StoreAggregate>, opts: { limit?: number; category?: string } = {}): { items: ChartRow[]; method: string } {
  const rows: Omit<ChartRow, "rank">[] = [];
  for (const r of snap.rows) {
    if (r.status !== "crawled" && !aggs.has(r.d)) continue;
    const raw = parseRaw(r.raw_json);
    if (opts.category && !((raw.category as string[] | undefined) ?? []).includes(opts.category)) continue;
    const a = aggs.get(r.d) ?? null;
    const useC = !!a && a.corroborated && a.success_score !== null;
    const crawlScore = r.co === null ? 0 : Math.round((r.co / 3) * 70 + (r.guest === 1 ? 15 : 0) + ((r.ag ?? 0) / 3) * 15);
    const score = useC ? Math.round(a!.success_score! * 85 + Math.min(15, a!.verified_purchase_share * 15)) : crawlScore;
    const v: ChartRow["values"] = {};
    const both = (k: string, cv: unknown, crawlV: unknown, enough: boolean, note?: string) => { v[k] = enough && cv !== null && cv !== undefined ? { value: cv, source: "community", ...(note ? { note } : {}) } : { value: crawlV, source: "crawl" }; };
    both("reached_payment_share", a?.success_score ?? null, r.co === null ? null : r.co >= 3 ? "probe reached payment screen" : `crawl checkout depth ${r.co}/3`, useC, a ? `${a.keys} keys` : undefined);
    both("guest_checkout", a && a.guest_yes_keys + a.guest_no_keys >= MIN_KEYS ? a.guest_yes_keys >= a.guest_no_keys : null, r.guest === null ? null : r.guest === 1, !!a && a.guest_yes_keys + a.guest_no_keys >= MIN_KEYS);
    both("pay_used", a?.pay_used.filter((p) => p.corroborated).map((p) => p.pay) ?? null, (raw.pay as string[] | undefined) ?? [], !!a && a.pay_used.some((p) => p.corroborated), "methods 2+ agents report actually using");
    both("tax_shown_before_payment", a && a.tax_before.yes + a.tax_before.no >= MIN_KEYS ? a.tax_before.yes > a.tax_before.no : null, ((raw.ship as Record<string, unknown> | undefined)?.pre_pay as boolean | null | undefined) ?? null, !!a && a.tax_before.yes + a.tax_before.no >= MIN_KEYS);
    both("shipping_usd_median", a?.observed.shipping_usd.corroborated ? a.observed.shipping_usd.median : null, null, !!a?.observed.shipping_usd.corroborated, "observed by agents");
    v.checkout_depth_crawl = { value: r.co, source: "crawl" };
    v.verified_purchase_share = { value: a ? a.verified_purchase_share : null, source: "community" };
    rows.push({ d: r.d, score, score_source: useC ? "community" : "crawl", values: v, community: a });
  }
  rows.sort((x, y) => y.score - x.score || (x.score_source === "community" ? -1 : 1) - (y.score_source === "community" ? -1 : 1) || x.d.localeCompare(y.d));
  const items = rows.slice(0, Math.min(opts.limit ?? 50, 500)).map((r, i) => ({ rank: i + 1, ...r }));
  return { items, method: `score 0-100. Community (when ${MIN_KEYS}+ distinct keys reported): 85 x weighted share of keys that reached the payment step or beyond (proof-attached notes weigh 2, checked proofs 3) + up to 15 for the share of keys with a purchase proof. Otherwise crawl: 70 x checkout depth/3 + 15 if guest checkout + 15 x agent access/3. Crawl data is never overwritten; values carry their source.` };
}
