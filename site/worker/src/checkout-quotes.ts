// record_checkout (Matt decisions 2026-10-31): agents' checkout-screen notes (build_experience_note preset=checkout) become a
// community quote for a store x ZIP3. Rules: ZIP3 only (never a full ZIP); each key's latest note counts once; the store owner's
// keys and keys younger than 7 days never count; KlickyMart's own crawler key (and any other declared seed key) is a level-1
// seed that never counts toward corroboration; 2+ independent counting keys that agree (within 5%) are needed before the quote
// drives est_total. Arithmetic (subtotal + shipping + tax = total, +-$0.02) and outliers (tax rate outside [0, state max + 2 pts],
// shipping over 3x the median) are stored but excluded and flagged.
import { STATE_TAX, zipToState } from "./landed";
import { keyFirstSeen, countsForRank, MIN_RANK_KEY_AGE_S } from "./key-age";
import { ownerKeys } from "./experience";
import { loadTips, summarize } from "./tips";

export const CHECKOUT_MIN_KEYS = 2;
export const AGREE_PCT = 5;
export const CHECKOUT_DEPTHS = ["payment", "paid", "delivered"];
export type QuoteRow = { id: string; pubkey: string; created_at: number; price: number | null; shipping: number | null; tax: number | null; total: number | null; currency: string | null; region: string | null };
export type QuoteNote = { id: string; pubkey: string; day: string; level: "seed" | "agent"; price: number; shipping: number; tax: number; total: number | null; tax_rate_pct: number;
  counts: boolean; flags: string[]; zaps?: { tips: number; sats: number; distinct_tippers: number }; njump: string };
export type CheckoutQuoteAgg = { d: string; zip3: string; state: string | null; keys_counting: number; seed_present: boolean; corroborated: boolean;
  median_shipping_usd: number | null; median_tax_rate_pct: number | null; status: string; notes: QuoteNote[]; rules: string };

const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const within = (x: number, m: number, pct: number, abs: number) => Math.abs(x - m) <= Math.max(abs, (Math.abs(m) * pct) / 100);
export const RULES = `Agent checkout quotes (build_experience_note preset=checkout, basis=visit, depth payment or later). ZIP3 only. Each key's latest note counts once. Store-owner keys and keys KlickyMart has seen for under 7 days do not count. Seed notes (KlickyMart's crawler or another declared seed key) are level 1 and never count. ${CHECKOUT_MIN_KEYS}+ counting keys whose shipping and tax rate agree within ${AGREE_PCT}% (or $0.50 / 0.1 pt) are needed before the quote drives est_total. Notes failing arithmetic (subtotal+shipping+tax vs total, +-$0.02) or outlier checks (tax rate outside 0..state max+2 pts, shipping over 3x the median) are shown but excluded.`;

/** Pure: aggregate already-filtered rows for one store x ZIP3. */
export function aggregateCheckoutQuotes(d: string, zip3: string, rows: QuoteRow[], o: { owners?: Set<string>; seeds?: Set<string>; aged?: (pk: string) => boolean; zaps?: Map<string, { tips: number; sats: number; distinct_tippers: number }> } = {}): CheckoutQuoteAgg {
  const st = zipToState(zip3 + "01") ?? zipToState(zip3 + "00");
  const maxRate = st && STATE_TAX[st] ? Math.max(STATE_TAX[st]![0], STATE_TAX[st]![1]) + 2 + 3 : 15; // +3: local add-ons above the average
  const latest = new Map<string, QuoteRow>();
  for (const r of [...rows].sort((a, b) => b.created_at - a.created_at)) if (r.region === zip3 && !latest.has(r.pubkey)) latest.set(r.pubkey, r);
  const notes: QuoteNote[] = [];
  for (const r of latest.values()) {
    if (typeof r.price !== "number" || !(r.price > 0) || typeof r.shipping !== "number" || typeof r.tax !== "number") continue;
    const flags: string[] = [];
    if ((r.currency ?? "USD") !== "USD") flags.push("not-usd");
    if (typeof r.total === "number" && Math.abs(r.price + r.shipping + r.tax - r.total) > 0.02) flags.push(`arithmetic: ${r.price}+${r.shipping}+${r.tax} != ${r.total}`);
    const rate = (r.tax / r.price) * 100;
    if (rate < 0 || rate > maxRate) flags.push(`outlier-tax: ${r2(rate)}% outside 0..${maxRate}% for ${st ?? "unknown state"}`);
    const seed = !!o.seeds?.has(r.pubkey);
    if (o.owners?.has(r.pubkey)) flags.push("store-owner key");
    if (!seed && o.aged && !o.aged(r.pubkey)) flags.push("new key (<7 days)");
    notes.push({ id: r.id, pubkey: r.pubkey, day: new Date(r.created_at * 1000).toISOString().slice(0, 10), level: seed ? "seed" : "agent", price: r.price, shipping: r.shipping, tax: r.tax, total: r.total,
      tax_rate_pct: r2(rate), counts: !seed && !flags.length, flags, ...(o.zaps?.get(r.id) ? { zaps: o.zaps.get(r.id)! } : {}), njump: `https://njump.me/${r.id}` });
  }
  // shipping outlier needs 3+ notes to define a median
  const base = notes.filter((n) => n.counts || n.level === "seed");
  const mShip0 = med(base.map((n) => n.shipping));
  if (base.length >= 3 && mShip0 !== null) for (const n of notes) if (mShip0 > 0 && n.shipping > 3 * mShip0) { n.flags.push(`outlier-shipping: $${n.shipping} > 3x median $${r2(mShip0)}`); n.counts = false; }
  const c = notes.filter((n) => n.counts);
  const mShip = med(c.map((n) => n.shipping)); const mRate = med(c.map((n) => n.tax_rate_pct));
  const agree = c.length >= CHECKOUT_MIN_KEYS && c.every((n) => within(n.shipping, mShip!, AGREE_PCT, 0.5) && within(n.tax_rate_pct, mRate!, AGREE_PCT, 0.1));
  const seedPresent = notes.some((n) => n.level === "seed");
  const status = agree ? `store-quoted by ${c.length} agents` : c.length >= CHECKOUT_MIN_KEYS ? `${c.length} agents disagree; not used` : c.length === 1 ? `1 agent saw${seedPresent ? " (+ seed)" : ""}; needs ${CHECKOUT_MIN_KEYS - 1} more` : seedPresent ? `seed only; needs ${CHECKOUT_MIN_KEYS} independent agents` : "no counting notes";
  return { d, zip3, state: st, keys_counting: c.length, seed_present: seedPresent, corroborated: agree, median_shipping_usd: mShip === null ? null : r2(mShip), median_tax_rate_pct: mRate === null ? null : r2(mRate), status, notes, rules: RULES };
}

export async function loadCheckoutQuotes(db: D1Database | undefined, d: string, zip3: string, seeds: Set<string>, now = Date.now()): Promise<CheckoutQuoteAgg | null> {
  if (!db || !/^\d{3}$/.test(zip3)) return null;
  try {
    const { results } = await db.prepare(`SELECT id,pubkey,created_at,price,shipping,tax,total,currency,region FROM experiences WHERE d=? AND region=? AND structured=1 AND COALESCE(basis,'visit')='visit' AND depth IN ('payment','paid','delivered') ORDER BY created_at DESC LIMIT 500`).bind(d, zip3).all<QuoteRow>();
    if (!results?.length) return null;
    const owners = await ownerKeys(db, d); const seen = await keyFirstSeen(db); const nowS = Math.floor(now / 1000);
    const tips = (await loadTips(db, d)).byNote; const zaps = new Map<string, { tips: number; sats: number; distinct_tippers: number }>();
    for (const r of results) { const t = tips.get(r.id); if (t?.length) { const s = summarize(t); zaps.set(r.id, { tips: s.tips, sats: s.sats, distinct_tippers: s.distinct_tippers }); } }
    return aggregateCheckoutQuotes(d, zip3, results, { owners, seeds, aged: (pk) => countsForRank(pk, null, seen, nowS, MIN_RANK_KEY_AGE_S), zaps });
  } catch { return null; }
}

/** Use a corroborated agent quote in a landed object, only when no store-checkout quote from our crawl is already there. Mutates. */
export function applyCheckoutQuote(landed: Record<string, unknown>, agg: CheckoutQuoteAgg | null, drill: string): void {
  if (!agg) return;
  const notesSummary = { status: agg.status, keys_counting: agg.keys_counting, seed_present: agg.seed_present, corroborated: agg.corroborated, median_shipping_usd: agg.median_shipping_usd, median_tax_rate_pct: agg.median_tax_rate_pct, zip3: agg.zip3, notes: agg.notes.length, drill_down: drill };
  landed.agent_checkout_quotes = notesSummary;
  const price = landed.item_price;
  if (!agg.corroborated || typeof price !== "number" || landed.store_quote || agg.median_shipping_usd === null || agg.median_tax_rate_pct === null) return;
  const ship = agg.median_shipping_usd; const tax = r2((price * agg.median_tax_rate_pct) / 100);
  landed.shipping = { usd: ship, label: "observed", source: { method: "agent-checkout", keys: agg.keys_counting, zip3: agg.zip3, drill_down: drill } };
  landed.est_tax = tax; landed.tax_source = { method: "agent checkout quotes", keys: agg.keys_counting, rate_pct: agg.median_tax_rate_pct };
  landed.est_total = r2(price + ship + tax);
  landed.est_total_label = `agent-checkout quotes (${agg.keys_counting} independent keys)`;
  landed.est_total_note = `item_price + median shipping and tax rate seen at the payment step by ${agg.keys_counting} independent agents in ZIP3 ${agg.zip3}`;
}
