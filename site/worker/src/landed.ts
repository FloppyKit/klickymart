/** GO D3: landed-cost estimate by US ZIP. Tax is an ESTIMATE from Tax Foundation's "2026 Sales Tax Rates, Midyear Update"
 * (rates as of July 1, 2026): state rate + population-weighted average combined rate. Local rates vary by address; the store's
 * own checkout is authoritative. Shipping comes only from the record (stated free-shipping threshold, observed ship quotes). */
import { shipOf } from "./explain";
import { ruleCondition } from "./ship-rules";

export const TAX_SRC = "https://taxfoundation.org/data/all/state/2026-sales-tax-rates-midyear/";
// state: [state rate %, average combined state+local %]
export const STATE_TAX: Record<string, [number, number]> = {
  AL: [4, 9.46], AK: [0, 1.82], AZ: [5.6, 8.54], AR: [6.5, 9.48], CA: [7.25, 9.03], CO: [2.9, 7.89], CT: [6.35, 6.35], DE: [0, 0], DC: [6, 6], FL: [6, 6.98],
  GA: [4, 7.56], HI: [4, 4.5], ID: [6, 6.03], IL: [6.25, 8.98], IN: [7, 7], IA: [6, 6.94], KS: [6.5, 8.71], KY: [6, 6], LA: [5, 10.13], ME: [5.5, 5.5],
  MD: [6, 6], MA: [6.25, 6.25], MI: [6, 6], MN: [6.875, 8.14], MS: [7, 7.06], MO: [4.225, 8.44], MT: [0, 0], NE: [5.5, 6.98], NV: [6.85, 8.24], NH: [0, 0],
  NJ: [6.625, 6.6], NM: [4.875, 7.68], NY: [4, 8.54], NC: [4.75, 7.1], ND: [5, 7.09], OH: [5.75, 7.29], OK: [4.5, 9.06], OR: [0, 0], PA: [6, 6.34], RI: [7, 7],
  SC: [6, 7.49], SD: [4.2, 6.11], TN: [7, 9.61], TX: [6.25, 8.2], UT: [6.1, 7.42], VT: [6, 6.43], VA: [5.3, 5.77], WA: [6.5, 9.57], WV: [6, 6.6], WI: [5, 5.72], WY: [4, 5.39],
};
// USPS 3-digit ZIP prefix ranges -> state (inclusive).
const RANGES: [number, number, string][] = [
  [5, 5, "NY"], [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"], [50, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"],
  [150, 196, "PA"], [197, 199, "DE"], [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"],
  [320, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"],
  [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"],
  [660, 679, "KS"], [680, 693, "NE"], [700, 715, "LA"], [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"],
  [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"], [885, 885, "TX"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];
export function zipToState(zip: string): string | null {
  if (!/^\d{5}$/.test(zip)) return null;
  const p = parseInt(zip.slice(0, 3), 10);
  for (const [a, b, s] of RANGES) if (p >= a && p <= b) return s;
  return null;
}
/** ZIP codes that are well-formed but are placeholders, not assigned to any address. */
export const PLACEHOLDER_ZIPS = new Set(["00000", "11111", "12345", "99999", "22222", "33333", "44444", "55555", "66666", "77777", "88888"]);
export function validZip(z: string | null | undefined): string | null { return z && /^\d{5}$/.test(z) && !PLACEHOLDER_ZIPS.has(z) && zipToState(z) ? z : null; }
export const ZIP_ERROR = "zip must be a real 5-digit US ZIP code (placeholders such as 99999 or 00000 are rejected because they map to no address)";

export type ShipRule = { type: "free" | "free_over" | "flat" | "per_region" | "calculated"; usd?: number | null; min_usd?: number | null; region?: string | null; method?: string | null; quote?: string; conditions?: string | null };
export type ShipPolicy = { rules: ShipRule[]; src?: string | null; checked_at?: string; ships_us?: boolean | null };
const regionHits = (region: string | null | undefined, st: string | null) => {
  if (!region || region === "US") return st !== null;
  if (region === "contiguous-US") return st !== null && !["AK", "HI", "PR"].includes(st);
  if (region === "AK-HI") return st === "AK" || st === "HI";
  if (region === "intl") return false;
  return region.split(",").map((x) => x.trim().toUpperCase()).includes(st ?? "");
};
/** Shipping from the store's published policy for this ZIP's state and the cart value. Returns null unless a rule
 * determines the price (never guesses). Region-specific rules beat generic ones. */
export function policyShip(p: ShipPolicy | undefined, st: string | null, subtotal: number): { usd: number; rule: ShipRule } | null {
  if (!p?.rules?.length || st === null) return null;
  // Member-only / promo / conditional rules never apply to a guest agent.
  const rs = p.rules.filter((r) => regionHits(r.region, st) && !ruleCondition(r));
  const specific = (r: ShipRule) => (r.region && r.region !== "US" ? 0 : 1);
  rs.sort((a, b) => specific(a) - specific(b));
  // "always free" next to a "free over $X" rule is ambiguous (members-only, promos): trust only the threshold then.
  const hasThreshold = rs.some((r) => r.type === "free_over");
  const free = hasThreshold ? undefined : rs.find((r) => r.type === "free"); if (free) return { usd: 0, rule: free };
  const fo = rs.find((r) => r.type === "free_over" && typeof r.min_usd === "number" && subtotal >= r.min_usd!); if (fo) return { usd: 0, rule: fo };
  const fixed = rs.find((r) => (r.type === "per_region" || r.type === "flat") && typeof r.usd === "number"); if (fixed) return { usd: fixed.usd!, rule: fixed };
  return null;
}

/** Landed-cost view of one record for a ZIP (and optional item price). Unknown stays null. */
export type OfferShip = { usd: number; n?: number; src?: string; me?: string; note?: string };
/** Gift cards: a general gift card's sale is not taxed in any US state (tax is due when it is redeemed). Prepaid phone cards and
 * vouchers for one named product can be taxed at sale, so those stay unknown. */
export const GIFT_CARD_TAX = { taxed_at_sale: false, rule: "gift card sale is not taxable in US states; sales tax is charged when the card is redeemed", src: ["https://taxfreedates.com/items/gift-cards/", "https://dor.wa.gov/forms-publications/publications-subject/tax-topics/gift-cards-gift-certificates-and-layaway-purchases"] };
const PHONE_CARD_RX = /\b(phone|airtime|top-?up|mobile|calling|prepaid (wireless|phone)|sim|data plan|voucher for)\b/i;
export type LandedOpts = { giftCard?: boolean; digital?: boolean; title?: string };
export function landedFor(raw: Record<string, unknown>, zip: string, price?: number | null, offerShip?: OfferShip | null, opts: LandedOpts = {}) {
  const st = zipToState(zip);
  const s = shipOf(raw);
  const t = st ? STATE_TAX[st] : undefined;
  const lc = (raw.landed as { ship_quotes?: { zip?: string; amount: number; method?: string; src?: string; checked_at?: string }[] } | undefined) ?? {};
  const quote = (lc.ship_quotes ?? []).find((q) => q.zip === zip) ?? (lc.ship_quotes ?? [])[0] ?? null;
  const freeShip = s.free_min_usd !== null && typeof price === "number" ? price >= s.free_min_usd : null;
  const out: Record<string, unknown> = {
    zip, state: st,
    tax: t ? { state_rate_pct: t[0], avg_combined_rate_pct: t[1], source: "estimated", src: TAX_SRC, note: "state rate plus population-weighted average local rate (Tax Foundation, July 1 2026); the exact rate depends on the street address" } : null,
    tax_shown_before_payment: s.pre_pay,
    ships_us: s.ships_us,
    free_ship_min_usd: s.free_min_usd,
    ship_quote: quote,
  };
  if (typeof price === "number") {
    // Shipping, best evidence first: the product page's own structured data, then the store's free-shipping threshold, then a ZIP quote.
    let ship: number | null = null; let shipSrc: Record<string, unknown> | null = null;
    let label: "observed" | "policy-derived" | "unknown" = "unknown";
    const pol = raw.ship_policy as ShipPolicy | undefined;
    const ps = policyShip(pol, st, price);
    if (offerShip && typeof offerShip.usd === "number") { ship = offerShip.usd; label = "observed"; shipSrc = { method: offerShip.me ?? "jsonld-shippingDetails", src: offerShip.src ?? null, note: offerShip.note ?? null }; }
    else if (quote) { ship = quote.amount; label = "observed"; shipSrc = { method: quote.method ?? "ship-quote", src: quote.src ?? null, checked_at: quote.checked_at ?? null }; }
    else if (ps) { ship = ps.usd; label = "policy-derived"; shipSrc = { method: "store shipping policy", rule: ps.rule.type, region: ps.rule.region ?? "US", ...(ps.rule.min_usd != null ? { min_usd: ps.rule.min_usd } : {}), quote: ps.rule.quote ?? null, src: pol?.src ?? null, checked_at: pol?.checked_at ?? null, note: `applies to ${st} for a $${price} cart; the store can change it at checkout` }; }
    else if (freeShip === true) { ship = 0; label = "policy-derived"; shipSrc = { method: "free-shipping-threshold", threshold_usd: s.free_min_usd }; }
    else if (opts.digital) { ship = 0; label = "policy-derived"; shipSrc = { method: "digital delivery", note: "digital gift card delivered by email (the store's checkout asks for an email, not an address)" }; }
    const skipped = (pol?.rules ?? []).filter((r) => regionHits(r.region, st) && ruleCondition(r)).map((r) => ({ rule: r.type, condition: ruleCondition(r), quote: r.quote ?? null }));
    if (skipped.length) out.shipping_rules_not_for_guests = skipped;
    out.item_price = price;
    out.free_shipping_applies = freeShip;
    const why = pol?.rules?.length ? `unknown: the store's policy (${pol.rules.map((r) => r.type + (r.min_usd != null ? ">=$" + r.min_usd : "")).join(", ")}) does not set a price for a $${price} cart to ${st}` : "unknown: no public structured shipping cost, ZIP quote or published shipping policy for this store/item";
    out.shipping = { usd: ship, label, source: shipSrc, ...(ship === null ? { note: why } : {}) };
    let tax: number | null = t ? Math.round(price * t[1]) / 100 : null;
    if (opts.giftCard) {
      if (PHONE_CARD_RX.test(opts.title ?? "")) { tax = null; out.tax_policy = { status: "unknown", note: "prepaid phone/airtime cards and single-product vouchers can be taxed at sale; not determined" }; }
      else { tax = t ? 0 : null; out.tax_policy = { status: "not-taxed", ...GIFT_CARD_TAX }; }
    }
    out.est_tax = tax;
    const known = ship !== null && tax !== null;
    out.est_total = known ? Math.round((price + ship! + tax!) * 100) / 100 : null;
    out.est_total_label = known ? (label === "observed" ? "observed shipping + estimated tax" : "policy-derived shipping + estimated tax") : "unknown";
    if (!known) out.est_total_note = `no total: ${[ship === null ? "shipping" : null, tax === null ? "tax" : null].filter(Boolean).join(" and ")} unknown; parts are given separately`;
    else out.est_total_note = "price + shipping + estimated tax (state + average local rate; exact tax depends on the street address)";
  }
  return out;
}
