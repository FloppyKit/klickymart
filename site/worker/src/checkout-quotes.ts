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

// CK-1 (Klicky Audit 2026-10-30): minimum raised from 2 to 3. Corroboration is NOT sybil-resistant, only sybil-raising.
export const CHECKOUT_MIN_KEYS = 3;
export const MAX_SHIPPING_USD = 500;
export const MAX_SUBTOTAL_USD = 100000;
export const QUOTE_MAX_AGE_S = 90 * 86400; // CK-7
export const MIN_PRIOR_NOTES = 2; export const MIN_PRIOR_DAYS = 2; // CK-1 history beyond age
export type KeyHistory = { notes: number; days: number };
/** CK-2: strict money: plain decimal, max 2 dp, no exponent/hex/sign/NaN/Infinity, <= max. Returns null when invalid. */
export function parseMoney(v: unknown, max: number): number | null {
  if (typeof v === "number") { if (!Number.isFinite(v) || v < 0 || v > max || Math.round(v * 100) / 100 !== v) return null; return v; }
  if (typeof v !== "string") return null;
  const t = v.trim(); if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t); return n <= max ? n : null;
}
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
export const RULES = `Agent checkout quotes (build_experience_note preset=checkout, basis=visit, depth payment or later). ZIP3 only. Each key's latest note counts once. Store-owner keys, keys KlickyMart has seen for under 7 days, flagged notes or keys, and keys without ${MIN_PRIOR_NOTES}+ prior unflagged notes on ${MIN_PRIOR_DAYS}+ distinct days do not count. Keys sharing a NIP-05, lud16 or zap wallet are grouped as one key. Notes older than 90 days are ignored. Money must be a plain decimal (max 2 dp; shipping <= $${MAX_SHIPPING_USD}, subtotal <= $${MAX_SUBTOTAL_USD}). Corroboration raises the cost of a sybil attack; it does not prevent one. Seed notes (KlickyMart's crawler or another declared seed key) are level 1 and never count. ${CHECKOUT_MIN_KEYS}+ counting keys (a majority of counting keys) whose shipping and tax rate agree within ${AGREE_PCT}% (or $0.50 / 0.1 pt) of the median are needed; the quote uses the median of that agreeing set before the quote drives est_total. Notes failing arithmetic (subtotal+shipping+tax vs total, +-$0.02) or outlier checks (tax rate outside 0..state max+2 pts, shipping over 3x the median) are shown but excluded.`;

/** Pure: aggregate already-filtered rows for one store x ZIP3. */
export function aggregateCheckoutQuotes(d: string, zip3: string, rows: QuoteRow[], o: { owners?: Set<string>; seeds?: Set<string>; aged?: (pk: string) => boolean; flaggedNotes?: Set<string>; flaggedKeys?: Set<string>; identities?: Map<string, string[]>; history?: Map<string, KeyHistory>; nowS?: number; zaps?: Map<string, { tips: number; sats: number; distinct_tippers: number }> } = {}): CheckoutQuoteAgg {
  const st = zipToState(zip3 + "01") ?? zipToState(zip3 + "00");
  const maxRate = st && STATE_TAX[st] ? Math.max(STATE_TAX[st]![0], STATE_TAX[st]![1]) + 2 + 3 : 15; // +3: local add-ons above the average
  const latest = new Map<string, QuoteRow>();
  const minTs = o.nowS !== undefined ? o.nowS - QUOTE_MAX_AGE_S : -Infinity;
  for (const r of [...rows].sort((a, b) => b.created_at - a.created_at)) if (r.region === zip3 && r.created_at >= minTs && !latest.has(r.pubkey)) latest.set(r.pubkey, r);
  const notes: QuoteNote[] = [];
  for (const r of latest.values()) {
    if (typeof r.price !== "number" || !(r.price > 0) || typeof r.shipping !== "number" || typeof r.tax !== "number") continue;
    const flags: string[] = [];
    if (parseMoney(r.price, MAX_SUBTOTAL_USD) === null || parseMoney(r.shipping, MAX_SHIPPING_USD) === null || parseMoney(r.tax, MAX_SUBTOTAL_USD) === null || (r.total !== null && parseMoney(r.total, MAX_SUBTOTAL_USD + MAX_SHIPPING_USD + MAX_SUBTOTAL_USD) === null)) {
      flags.push("bad-money: not a plain 2-dp amount within caps");
      notes.push({ id: r.id, pubkey: r.pubkey, day: new Date(r.created_at * 1000).toISOString().slice(0, 10), level: o.seeds?.has(r.pubkey) ? "seed" : "agent", price: r.price, shipping: r.shipping, tax: r.tax, total: r.total, tax_rate_pct: 0, counts: false, flags, njump: `https://njump.me/${r.id}` });
      continue;
    }
    if ((r.currency ?? "USD") !== "USD") flags.push("not-usd");
    if (typeof r.total === "number" && Math.abs(r.price + r.shipping + r.tax - r.total) > 0.02) flags.push(`arithmetic: ${r.price}+${r.shipping}+${r.tax} != ${r.total}`);
    const rate = (r.tax / r.price) * 100;
    if (rate < 0 || rate > maxRate) flags.push(`outlier-tax: ${r2(rate)}% outside 0..${maxRate}% for ${st ?? "unknown state"}`);
    const seed = !!o.seeds?.has(r.pubkey);
    if (o.owners?.has(r.pubkey)) flags.push("store-owner key");
    if (!seed && o.aged && !o.aged(r.pubkey)) flags.push("new key (<7 days)");
    if (o.flaggedNotes?.has(r.id)) flags.push("flagged note");
    if (o.flaggedKeys?.has(r.pubkey)) flags.push("flagged key");
    if (!seed && o.history) { const h = o.history.get(r.pubkey) ?? { notes: 0, days: 0 }; if (h.notes < MIN_PRIOR_NOTES || h.days < MIN_PRIOR_DAYS) flags.push(`thin history: ${h.notes} prior unflagged notes on ${h.days} days (needs ${MIN_PRIOR_NOTES} on ${MIN_PRIOR_DAYS})`); }
    notes.push({ id: r.id, pubkey: r.pubkey, day: new Date(r.created_at * 1000).toISOString().slice(0, 10), level: seed ? "seed" : "agent", price: r.price, shipping: r.shipping, tax: r.tax, total: r.total,
      tax_rate_pct: r2(rate), counts: !seed && !flags.length, flags, ...(o.zaps?.get(r.id) ? { zaps: o.zaps.get(r.id)! } : {}), njump: `https://njump.me/${r.id}` });
  }
  // CK-1: keys sharing a NIP-05 / lud16 / zap identity are one key: keep the latest counting note per group.
  if (o.identities) {
    const owner = new Map<string, QuoteNote>();
    const byTime = notes.filter((n) => n.counts).sort((a, b) => (latest.get(b.pubkey)!.created_at - latest.get(a.pubkey)!.created_at));
    for (const n of byTime) {
      const ids = o.identities.get(n.pubkey) ?? [];
      const hit = ids.map((i) => owner.get(i)).find((x) => x && x.pubkey !== n.pubkey);
      if (hit) { n.counts = false; n.flags.push(`sibling of ${hit.pubkey.slice(0, 12)} (shared identity)`); }
      for (const i of ids) if (!owner.has(i)) owner.set(i, hit ?? n);
    }
  }
  // shipping outlier needs 3+ notes to define a median (always true once 3 keys are required)
  const base = notes.filter((n) => n.counts || n.level === "seed");
  const mShip0 = med(base.map((n) => n.shipping));
  if (base.length >= 3 && mShip0 !== null) for (const n of notes) if (mShip0 > 0 && n.shipping > 3 * mShip0) { n.flags.push(`outlier-shipping: $${n.shipping} > 3x median $${r2(mShip0)}`); n.counts = false; }
  const counting = notes.filter((n) => n.counts);
  // CK-6: one aged key can't veto. Agreeing set = notes within tolerance of the overall median; it must be 3+ keys and a majority.
  const m0s = med(counting.map((n) => n.shipping)); const m0r = med(counting.map((n) => n.tax_rate_pct));
  const c = counting.filter((n) => within(n.shipping, m0s!, AGREE_PCT, 0.5) && within(n.tax_rate_pct, m0r!, AGREE_PCT, 0.1));
  const agree = c.length >= CHECKOUT_MIN_KEYS && c.length * 2 > counting.length;
  for (const n of counting) if (!c.includes(n)) n.flags.push("disagrees with median (not used)");
  const mShip = agree ? med(c.map((n) => n.shipping)) : m0s; const mRate = agree ? med(c.map((n) => n.tax_rate_pct)) : m0r;
  const seedPresent = notes.some((n) => n.level === "seed");
  const n = counting.length;
  const status = agree ? `store-quoted by ${c.length} distinct aged keys` : n >= CHECKOUT_MIN_KEYS ? `${n} agents disagree; not used` : n >= 1 ? `${n} agent${n > 1 ? "s" : ""} saw${seedPresent ? " (+ seed)" : ""}; needs ${CHECKOUT_MIN_KEYS - n} more` : seedPresent ? `seed only; needs ${CHECKOUT_MIN_KEYS} independent agents` : "no counting notes";
  return { d, zip3, state: st, keys_counting: agree ? c.length : n, seed_present: seedPresent, corroborated: agree, median_shipping_usd: mShip === null ? null : r2(mShip), median_tax_rate_pct: mRate === null ? null : r2(mRate), status, notes, rules: RULES };
}

export async function loadCheckoutQuotes(db: D1Database | undefined, d: string, zip3: string, seeds: Set<string>, now = Date.now()): Promise<CheckoutQuoteAgg | null> {
  if (!db || !/^\d{3}$/.test(zip3)) return null;
  try {
    const { results } = await db.prepare(`SELECT id,pubkey,created_at,price,shipping,tax,total,currency,region FROM experiences WHERE d=? AND region=? AND structured=1 AND COALESCE(basis,'visit')='visit' AND depth IN ('payment','paid','delivered') ORDER BY created_at DESC LIMIT 500`).bind(d, zip3).all<QuoteRow>();
    if (!results?.length) return null;
    const owners = await ownerKeys(db, d); const seen = await keyFirstSeen(db); const nowS = Math.floor(now / 1000);
    const tips = (await loadTips(db, d)).byNote; const zaps = new Map<string, { tips: number; sats: number; distinct_tippers: number }>();
    for (const r of results) { const t = tips.get(r.id); if (t?.length) { const s = summarize(t); zaps.set(r.id, { tips: s.tips, sats: s.sats, distinct_tippers: s.distinct_tippers }); } }
    // CK-1 inputs. Flags: note_flags rows with reasons; a key with any flagged note is a flagged key.
    const flaggedNotes = new Set<string>(); const flaggedKeys = new Set<string>();
    try { for (const f of (await db.prepare("SELECT id, pubkey FROM note_flags WHERE reasons_json != '[]'").all<{ id: string; pubkey: string }>()).results ?? []) { flaggedNotes.add(f.id); flaggedKeys.add(f.pubkey); } } catch { /* table missing: no flags */ }
    // Identities: kind-0 profiles aren't stored, so group on what we have: NIP-05 from nip05_checks, lud16 tags on the key's
    // experience notes (also the zap wallet named in the note), and owner zap keys are already excluded via ownerKeys.
    const pks = [...new Set(results.map((r) => r.pubkey))]; const identities = new Map<string, string[]>(); const history = new Map<string, KeyHistory>();
    const add = (pk: string, id: string) => { const a = identities.get(pk) ?? []; if (!a.includes(id)) a.push(id); identities.set(pk, a); };
    const quoteIds = new Set(results.map((r) => r.id));
    for (let i = 0; i < pks.length; i += 50) {
      const chunk = pks.slice(i, i + 50); const q = chunk.map(() => "?").join(",");
      try { for (const n of (await db.prepare(`SELECT pubkey, nip05 FROM nip05_checks WHERE pubkey IN (${q}) AND nip05 IS NOT NULL AND nip05 != ''`).bind(...chunk).all<{ pubkey: string; nip05: string }>()).results ?? []) add(n.pubkey, "nip05:" + n.nip05.toLowerCase()); } catch { /* */ }
      const days = new Map<string, Set<string>>(); const cnt = new Map<string, number>();
      for (const e of (await db.prepare(`SELECT id, pubkey, received_day, raw_json FROM experiences WHERE pubkey IN (${q}) ORDER BY created_at DESC LIMIT 5000`).bind(...chunk).all<{ id: string; pubkey: string; received_day: string; raw_json: string }>()).results ?? []) {
        try { for (const t of (JSON.parse(e.raw_json) as { tags?: string[][] }).tags ?? []) if ((t[0] === "lud16" || t[0] === "zap") && t[1]) add(e.pubkey, "wallet:" + String(t[1]).toLowerCase()); } catch { /* */ }
        if (quoteIds.has(e.id) || flaggedNotes.has(e.id)) continue;
        cnt.set(e.pubkey, (cnt.get(e.pubkey) ?? 0) + 1); const s = days.get(e.pubkey) ?? new Set(); s.add(e.received_day); days.set(e.pubkey, s);
      }
      for (const pk of chunk) history.set(pk, { notes: cnt.get(pk) ?? 0, days: days.get(pk)?.size ?? 0 });
    }
    return aggregateCheckoutQuotes(d, zip3, results, { owners, seeds, aged: (pk) => countsForRank(pk, null, seen, nowS, MIN_RANK_KEY_AGE_S), flaggedNotes, flaggedKeys, identities, history, nowS, zaps });
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
