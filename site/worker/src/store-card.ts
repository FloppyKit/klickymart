import { landedOptsFor } from "./offers";
/** Store facts attached to every product result (indexed offers and live Shopify Catalog products). One source: storeFacts() + record. */
import type { Snapshot } from "./index-mem";
import { storeFacts, shipOf, deriveVerdict } from "./explain";
import { parseRaw } from "./records-api";
import { landedFor, type OfferShip } from "./landed";

export const hostOf = (u: unknown) => { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

/** Registrable domain (eTLD+1) with a small public-suffix rule: example.co.uk, example.com.au, shop.example.com -> example.com. */
export function registrable(h: string): string {
  const p = h.toLowerCase().replace(/\.$/, "").split(".");
  if (p.length <= 2) return p.join(".");
  const sl = p[p.length - 2]!, tld = p[p.length - 1]!;
  return (tld.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"].includes(sl)) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}
const SUB_PREF = ["", "www.", "us.", "shop.", "store.", "en.", "en-us."];
const idxCache = new WeakMap<object, { byD: Map<string, Snapshot["rows"][number]>; byReg: Map<string, Snapshot["rows"][number][]> }>();
function idx(snap: Snapshot) {
  let x = idxCache.get(snap.rows);
  if (!x) {
    const byD = new Map(snap.rows.map((r) => [r.d, r])); const byReg = new Map<string, Snapshot["rows"][number][]>();
    for (const r of snap.rows) { const k = registrable(r.d); (byReg.get(k) ?? byReg.set(k, []).get(k)!).push(r); }
    x = { byD, byReg }; idxCache.set(snap.rows, x);
  }
  return x;
}
/** Index row for a domain or URL. Exact (or www.) first, then parent domains (us.store.com -> store.com), then a sibling
 * under the same registrable domain (soundcore.com -> us.soundcore.com): www., us., shop., store. ... preferred, else the
 * only row under that domain. */
export function findRow(snap: Snapshot, domainOrUrl: string) {
  const h = domainOrUrl.includes("/") ? hostOf(domainOrUrl) : domainOrUrl.toLowerCase().replace(/^www\./, "");
  if (!h) return null;
  const { byD, byReg } = idx(snap);
  if (byD.get(h)) return byD.get(h)!;
  if (byD.get(`www.${h}`)) return byD.get(`www.${h}`)!;
  const parts = h.split(".");
  for (let i = 1; i < parts.length - 1; i++) { const r = byD.get(parts.slice(i).join(".")); if (r) return r; }
  const reg = registrable(h); const sib = byReg.get(reg) ?? [];
  for (const p of SUB_PREF) { const r = sib.find((x) => x.d === p + reg); if (r) return r; }
  return sib.length === 1 ? sib[0]! : null;
}

/** Wallet booleans from the store's full pay list (pay + pay_online + unscoped). true = seen; false only when the store's own
 * wallet list was read; null = not observed. Same function for /check and every product row, so they can't disagree. */
export function walletFacts(raw: Record<string, unknown>, payAll?: string[]) {
  const pay = payAll ?? [...new Set([...(raw.pay as string[] ?? []), ...(raw.pay_online as string[] ?? [])])];
  return {
    pay_shop_pay: pay.includes("spay") ? true : raw.wallets_checked ? false : null,
    pay_link: pay.includes("link") ? true : (raw.link_checked || raw.wallets_checked ? false : null),
    pay_apple_pay: pay.includes("apay") ? true : raw.wallets_checked ? false : null,
    pay_google_pay: pay.includes("gpay") ? true : raw.wallets_checked ? false : null,
    pay_paypal: pay.includes("pp") ? true : null,
  };
}

export function storeCard(snap: Snapshot, domainOrUrl: string, origin: string) {
  const row = findRow(snap, domainOrUrl);
  const domain = domainOrUrl.includes("/") ? hostOf(domainOrUrl) : domainOrUrl;
  if (!row) return { domain, indexed: false, note: "store not indexed: no KlickyMart record, so checkout, pay and shipping facts are unknown" };
  const raw = parseRaw(row.raw_json);
  const pay = [...new Set([...(Array.isArray(raw.pay) ? (raw.pay as string[]) : []), ...(Array.isArray(raw.pay_online) ? (raw.pay_online as string[]) : [])])];
  const has = (c: string) => (pay.includes(c) ? true : pay.length ? false : null);
  const payGap = !pay.length && !raw.pay_src && !(Array.isArray(raw.pay_unscoped) && (raw.pay_unscoped as unknown[]).length);
  const sh = shipOf(raw);
  const cm = raw.checkout_map as { stage?: string; first_blocker?: { kind?: string } } | undefined;
  return {
    domain: row.d, indexed: true, verdict: deriveVerdict(row, raw).verdict,
    ...storeFacts(row),
    // Wallets are "false" only when the store's own wallet list was read (a Shopify product page's accelerated-checkout list); otherwise unknown.
    pay, ...walletFacts(raw, pay),
    ...(raw.wallets_checked ? { wallets_src: raw.wallets_checked } : {}), pay_btc_onchain: has("btc"), pay_lightning: pay.length ? pay.includes("ln") || pay.includes("lnurl") : null,
    btc_indirect: (raw.btc_indirect as unknown[] | undefined) ?? null,
    ships_us: sh.ships_us, free_ship_min_usd: sh.free_min_usd, tax_shown_before_payment: sh.pre_pay,
    checkout_stage: cm?.stage ?? null, first_blocker: cm?.first_blocker?.kind ?? null,
    shipping_policy: (raw.ship_policy as unknown) ?? null,
    ...(row.status === "blocked-tos" ? { tos: "bans-automation", tos_quote: (raw.tos_q as string | undefined) ?? null, tos_url: (raw.tos_url as string | undefined) ?? null,
      tos_note: "The store's terms ban automated access, so KlickyBot recorded that fact and did not crawl it; pay/checkout/shipping facts stay unknown." } : {}),
    pay_note: payGap ? "payment methods not observed by our crawl (unknown, not none); pay_link is null unless the store's own pages name Link" : "pay_link is null unless the store's own pages name Link; null = not observed",
    record: `${origin}/records/${encodeURIComponent(row.d)}`,
  };
}

/** Landed parts for any priced product at a ZIP, using the indexed record when the store is indexed. */
export function landedForProduct(snap: Snapshot, domainOrUrl: string, zip: string, price: number, offerShip?: OfferShip | null, title = "") {
  const row = findRow(snap, domainOrUrl);
  const raw = row ? parseRaw(row.raw_json) : {};
  return landedFor(raw, zip, price, offerShip ?? null, landedOptsFor(title, raw));
}
