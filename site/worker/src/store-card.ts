/** Store facts attached to every product result (indexed offers and live Shopify Catalog products). One source: storeFacts() + record. */
import type { Snapshot } from "./index-mem";
import { storeFacts, shipOf } from "./explain";
import { parseRaw } from "./records-api";
import { landedFor, type OfferShip } from "./landed";

export const hostOf = (u: unknown) => { try { return new URL(String(u)).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

export function findRow(snap: Snapshot, domainOrUrl: string) {
  const h = domainOrUrl.includes("/") ? hostOf(domainOrUrl) : domainOrUrl.toLowerCase().replace(/^www\./, "");
  if (!h) return null;
  const byD = new Map(snap.rows.map((r) => [r.d, r]));
  const parts = h.split(".");
  for (let i = 0; i < parts.length - 1; i++) { const r = byD.get(parts.slice(i).join(".")); if (r) return r; }
  return null;
}

export function storeCard(snap: Snapshot, domainOrUrl: string, origin: string) {
  const row = findRow(snap, domainOrUrl);
  const domain = domainOrUrl.includes("/") ? hostOf(domainOrUrl) : domainOrUrl;
  if (!row) return { domain, indexed: false, note: "store not indexed: no KlickyMart record, so checkout, pay and shipping facts are unknown" };
  const raw = parseRaw(row.raw_json);
  const pay = Array.isArray(raw.pay) ? (raw.pay as string[]) : [];
  const has = (c: string) => (pay.includes(c) ? true : pay.length ? false : null);
  const sh = shipOf(raw);
  const cm = raw.checkout_map as { stage?: string; first_blocker?: { kind?: string } } | undefined;
  return {
    domain: row.d, indexed: true, verdict: row.status === "crawled" ? "reachable" : row.status,
    ...storeFacts(row),
    pay, pay_shop_pay: has("spay"), pay_link: pay.includes("link") ? true : (raw.link_checked ? false : null), pay_btc_onchain: has("btc"), pay_lightning: pay.length ? pay.includes("ln") || pay.includes("lnurl") : null,
    btc_indirect: (raw.btc_indirect as unknown[] | undefined) ?? null,
    ships_us: sh.ships_us, free_ship_min_usd: sh.free_min_usd, tax_shown_before_payment: sh.pre_pay,
    checkout_stage: cm?.stage ?? null, first_blocker: cm?.first_blocker?.kind ?? null,
    shipping_policy: (raw.ship_policy as unknown) ?? null,
    ...(row.status === "blocked-tos" ? { tos: "bans-automation", tos_quote: (raw.tos_q as string | undefined) ?? null, tos_url: (raw.tos_url as string | undefined) ?? null,
      tos_note: "The store's terms ban automated access, so KlickyBot recorded that fact and did not crawl it; pay/checkout/shipping facts stay unknown." } : {}),
    pay_note: "pay_link is null unless the store's own pages name Link; null = not observed",
    record: `${origin}/records/${encodeURIComponent(row.d)}`,
  };
}

/** Landed parts for any priced product at a ZIP, using the indexed record when the store is indexed. */
export function landedForProduct(snap: Snapshot, domainOrUrl: string, zip: string, price: number, offerShip?: OfferShip | null) {
  const row = findRow(snap, domainOrUrl);
  return landedFor(row ? parseRaw(row.raw_json) : {}, zip, price, offerShip ?? null);
}
