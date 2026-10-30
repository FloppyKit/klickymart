/** GO D1: product offers observed by KlickyBot (deterministic: schema.org JSON-LD and Shopify /products.json only).
 * Shopify catalog (UCP) results are never stored: its usage guidelines forbid caching, so /offers can add them live (live=1). */
import type { Snapshot } from "./index-mem";
import { parseRaw } from "./records-api";
import { landedFor } from "./landed";

export interface Offer { d: string; n: string; b?: string | null; g?: string | null; m?: string | null; s?: string | null; p: number; c: string; st?: string | null; cd?: string | null; sl?: string | null; u: string; me: string; src: string; t: string }
let parsedFrom: string | null = null; let parsed: Offer[] = [];
export function parseOffers(ndjson: string): Offer[] {
  if (parsedFrom === ndjson) return parsed;
  parsed = ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Offer); parsedFrom = ndjson; return parsed;
}
import { queryTokens, offerTokens, coverage } from "./search-terms";
const normGtin = (g: string) => g.replace(/\D/g, "").replace(/^0+/, "");

export interface OfferQuery { gtin?: string; mpn?: string; q?: string; zip?: string | null; domain?: string; in_stock?: boolean; max_price?: number; limit?: number }
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
    return {
      domain: o.d, name: o.n, brand: o.b ?? null, gtin: o.g ?? null, mpn: o.m ?? null, sku: o.s ?? null,
      price: o.p, currency: o.c, stock: o.st ?? null, condition: o.cd ?? null, seller: o.sl ?? null, url: o.u,
      method: o.me, src: o.src, checked_at: o.t, match: { how, conf },
      store: row ? { verdict: row.status === "crawled" ? "reachable" : row.status, checkout_depth: row.co, guest: row.guest === null ? null : row.guest === 1, record: `${origin}/records/${encodeURIComponent(o.d)}` } : null,
      ...(zip && o.c === "USD" ? { landed: landedFor(raw, zip, o.p) } : {}),
    };
  });
  return { ok: true as const, body: { query: qy, count: items.length, total: scored.length, items,
    note: "Offers are KlickyBot's own observations from the store's public product data (JSON-LD or Shopify JSON) at checked_at; prices change, so confirm on the store page. Unknown fields are null, which means not observed." } };
}
