import { storeFacts } from "./explain";
import { storeCard, landedForProduct, hostOf } from "./store-card";
/** GO D1: product offers observed by KlickyBot (deterministic: schema.org JSON-LD and Shopify /products.json only).
 * Shopify catalog (UCP) results are never stored: its usage guidelines forbid caching, so /offers can add them live (live=1). */
import type { Snapshot } from "./index-mem";
import { parseRaw } from "./records-api";
import { landedFor, type LandedOpts } from "./landed";
import { productTypes } from "./product-quality";
/** Landed options for a product: gift-card tax policy, and digital delivery for stores that only sell digital gift cards. */
export function landedOptsFor(title: string, raw: Record<string, unknown>): LandedOpts {
  const giftCard = productTypes(title).includes("gift-card");
  const cats = [...((raw.category as string[] | undefined) ?? []), ...((raw.sub as string[] | undefined) ?? [])];
  const digital = giftCard && cats.includes("gift-cards") && !/\b(physical|plastic|mailed|by mail)\b/i.test(title);
  return { giftCard, digital, title };
}
/** One shipping status per row: the landed block's shipping when a ZIP was given, else the offer's own observation. */
export function rowShipping(landed: Record<string, any> | undefined, sh: Offer["sh"] | null | undefined) {
  if (landed?.shipping) return landed.shipping;
  return sh ? { usd: sh.usd, label: "observed", source: { method: sh.me ?? "jsonld-shippingDetails", src: sh.src ?? null, note: sh.note ?? null } } : { usd: null, label: "unknown", note: "give zip= for shipping from the store's policy" };
}

export interface Offer { d: string; n: string; b?: string | null; g?: string | null; m?: string | null; s?: string | null; p: number; c: string; st?: string | null; cd?: string | null; sl?: string | null; u: string; me: string; src: string; t: string; sh?: import("./landed").OfferShip | null; dn?: { face_usd: number; range?: (number | null)[]; count?: number | null; fee?: number | null; fee_pct?: number | null; price_usd?: number | null; fee_src?: string; fee_checked_at?: string; note?: string } | null }
let parsedFrom: string | null = null; let parsed: Offer[] = [];
export function parseOffers(ndjson: string): Offer[] {
  if (parsedFrom === ndjson) return parsed;
  parsed = ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Offer); parsedFrom = ndjson; return parsed;
}
import { queryTokens, offerTokens, coverage } from "./search-terms";
const normGtin = (g: string) => g.replace(/\D/g, "").replace(/^0+/, "");

export interface OfferQuery { gtin?: string; mpn?: string; q?: string; zip?: string | null; domain?: string; in_stock?: boolean; max_price?: number; limit?: number; condition?: string; type?: string; brand_strict?: boolean }
export function findOffers(offers: Offer[], snap: Snapshot, origin: string, qy: OfferQuery) {
  const limit = Math.min(Math.max(qy.limit ?? 20, 1), 100);
  const g = qy.gtin ? normGtin(qy.gtin) : null;
  const m = qy.mpn ? qy.mpn.toLowerCase().replace(/[^a-z0-9]/g, "") : null;
  const qt = qy.q ? queryTokens(qy.q) : [];
  if (!g && !m && !qt.length && !qy.domain) return { ok: false as const, message: "give gtin, mpn, q or domain" };
  const rows = new Map(snap.rows.map((r) => [r.d, r]));
  const scored: { o: Offer; conf: number; how: string }[] = [];
  for (const o of offers) {
    if (qy.domain && o.d !== qy.domain && o.d !== qy.domain.replace(/^www\./, "")) continue;
    let conf = 0, how = "";
    if (g && o.g && normGtin(o.g) === g) { conf = 1; how = "gtin"; }
    else if (m && o.m && o.m.toLowerCase().replace(/[^a-z0-9]/g, "") === m) { conf = 0.95; how = "mpn"; }
    else if (qt.length) {
      const hit = coverage(qt, offerTokens(o.n, o.b));
      if (hit === qt.length) { conf = 0.8; how = "name-all-words"; } else if (hit / qt.length >= 0.6 && qt.length >= 3) { conf = 0.5; how = "name-most-words"; }
    } else if (qy.domain && !g && !m) { conf = 0.1; how = "domain"; }
    if (!conf) continue;
    if (qy.in_stock && o.st !== "in") continue;
    if (qy.max_price !== undefined && o.p > qy.max_price) continue;
    scored.push({ o, conf, how });
  }
  const zip = qy.zip ?? null;
  const rank = (x: { o: Offer; conf: number }) => [-(x.conf), x.o.st === "in" ? 0 : x.o.st ? 2 : 1, -(rows.get(x.o.d)?.co ?? -1), x.o.p];
  scored.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!; return 0; });
  const items = scored.slice(0, limit).map(({ o, conf, how }) => {
    const row = rows.get(o.d);
    const raw = row ? parseRaw(row.raw_json) : {};
    const pay = o.dn?.price_usd ?? o.p; // what the buyer pays (gift-card fee included when observed)
    const landed = zip && o.c === "USD" ? landedFor(raw, zip, pay, o.sh ?? null, landedOptsFor(o.n, raw)) : undefined;
    return {
      domain: o.d, name: o.n, brand: o.b ?? null, gtin: o.g ?? null, mpn: o.m ?? null, sku: o.s ?? null,
      price: o.p, currency: o.c, stock: o.st ?? null, condition: o.cd ?? null, seller: o.sl ?? null, url: o.u,
      method: o.me, src: o.src, checked_at: o.t, match: { how, conf },
      ...(o.dn ? { denomination: o.dn, ...(o.dn.price_usd != null ? { face_value: o.p, price_with_fee: o.dn.price_usd, fee: o.dn.fee ?? null, fee_src: o.dn.fee_src ?? null, fee_checked_at: o.dn.fee_checked_at ?? null } : {}) } : {}),
      shipping: rowShipping(landed, o.sh),
      store: row ? { ...storeCard(snap, o.d, origin), checkout_depth: storeFacts(row).co, record: `${origin}/records/${encodeURIComponent(o.d)}` } : null,
      ...(landed ? { landed } : {}),
    };
  });
  return { ok: true as const, body: { query: qy, count: items.length, total: scored.length, items,
    note: "Offers are KlickyBot's own observations from the store's public product data (JSON-LD or Shopify JSON) at checked_at; prices change, so confirm on the store page. Unknown fields are null, which means not observed." } };
}

type LiveVariant = { url?: string; title?: string; price?: { amount?: number; currency?: string }; availability?: { available?: boolean } };
type LiveProduct = { id?: string; title?: string; variants?: LiveVariant[] };
/** Normalize live Shopify Catalog products into product results with store facts, then apply our filters AFTER fetching
 * (the catalog ignores max_price/in_stock). Nothing here is stored. */
export function liveItems(products: LiveProduct[], snap: Snapshot, origin: string, qy: OfferQuery) {
  const applied: string[] = []; let dropped = 0;
  const out: Record<string, unknown>[] = [];
  for (const p of products) {
    const vs = (p.variants ?? []).filter((v) => v.price?.amount != null);
    if (!vs.length) continue;
    const pool = qy.in_stock ? vs.filter((v) => v.availability?.available) : vs;
    const v = [...(pool.length ? pool : vs)].sort((a, b) => a.price!.amount! - b.price!.amount!)[0]!;
    const price = v.price!.amount! / 100, cur = v.price!.currency ?? null, avail = v.availability?.available ?? null;
    if (qy.in_stock && avail !== true) { dropped++; continue; }
    if (qy.max_price !== undefined && (cur !== "USD" || price > qy.max_price)) { dropped++; continue; }
    const card = storeCard(snap, v.url ?? "", origin);
    out.push({
      source: "shopify-catalog-live", title: p.title || v.title || null, name: p.title || v.title || null, variant: v.title ?? null, price, currency: cur, stock: avail === true ? "in" : avail === false ? "out" : null,
      url: v.url ?? null, domain: hostOf(v.url), checked_at: new Date().toISOString(), store: card,
      ...(qy.zip && cur === "USD" ? { landed: landedForProduct(snap, v.url ?? "", qy.zip, price, null, p.title || v.title || "") } : {}),
    });
    const last = out[out.length - 1]!; last.shipping = rowShipping(last.landed as Record<string, any> | undefined, null);
  }
  if (qy.max_price !== undefined) applied.push(`max_price<=${qy.max_price} USD`);
  if (qy.in_stock) applied.push("in_stock");
  return { items: out, filters_applied_after_fetch: applied, dropped_by_filters: dropped,
    note: applied.length ? `Shopify Catalog does not apply ${applied.join(" and ")}; KlickyMart filtered the live results after fetching (dropped ${dropped}).` : null };
}
