/** Product-level quality signals for offers (indexed and live): condition, product type, brand look-alikes,
 * model-number match, and dedupe by store + product. Pure functions; nothing is stored. */
export const CONDITIONS = ["new", "refurbished", "open-box", "used"] as const;
/** Filter values: the four conditions plus "unknown" (rows whose condition is not stated anywhere), selectable on its own. */
export const CONDITION_FILTERS = [...CONDITIONS, "unknown"] as const;
export type Condition = (typeof CONDITIONS)[number];
export const PRODUCT_TYPES = ["headphones", "earbuds", "headset", "speaker", "grinder", "gift-card", "bundle", "accessory"] as const;

const RESALE_STORES = /(^|\.)(unclaimedbaggage\.com|recellexchange\.com|thredup\.com|therealreal\.com|ebay\.com|backmarket\.com)$/;
/** Condition from the listing text. Returns {value, src}; value "new" only when the text says new/sealed, else null with
 * "not stated" (most new listings don't say), except resale stores which default to used. */
export function conditionOf(text: string, domain = ""): { condition: Condition | null; condition_src: string } {
  const t = text.toLowerCase();
  if (/\bopen[\s-]?box\b/.test(t)) return { condition: "open-box", condition_src: "listing title/url" };
  if (/\b(refurb|refurbished|renewed|reconditioned|certified pre-?owned)\b/.test(t)) return { condition: "refurbished", condition_src: "listing title/url" };
  if (/\b(used|pre-?owned|preowned|second-?hand|pre-?loved)\b/.test(t)) return { condition: "used", condition_src: "listing title/url" };
  if (/\b(brand new|new in box|sealed|nib)\b/.test(t)) return { condition: "new", condition_src: "listing title/url" };
  if (RESALE_STORES.test(domain)) return { condition: "used", condition_src: "store is a resale/liquidation store" };
  const host = domain.replace(/^www\./, "");
  if (/(^|[.-])open-?box/.test(host)) return { condition: "open-box", condition_src: "store sells open-box stock (store domain)" };
  if (/(^|[.-])(refurb|renewed)/.test(host)) return { condition: "refurbished", condition_src: "store sells refurbished stock (store domain)" };
  if (brandStoreOf(host)) return { condition: "new", condition_src: `the brand's own store (${host}) sells new stock unless the listing says otherwise` };
  return { condition: null, condition_src: "not stated in the listing (most new items don't say)" };
}

const TYPE_RX: [string, RegExp][] = [
  ["gift-card", /\bgift[\s-]?cards?\b|\be-?gift\b/],
  ["bundle", /\b(bundle|set)\b|\bset-|\s\+\s/],
  ["earbuds", /\b(ear ?buds?|in-ear|true wireless|tws)\b/],
  ["headset", /\b(headset|gaming headset)\b/],
  ["headphones", /\b(headphones?|over-ear|on-ear|cans)\b/],
  ["speaker", /\b(speaker|soundbar|sound bar)\b/],
  ["grinder", /\bgrinder\b/],
  ["accessory", /\b(case|cable|cushion|ear ?pads?|charger|adapter|stand|replacement)\b/],
];
const OVER_EAR = /\b(over[\s-]?ear|on[\s-]?ear|around[\s-]?(the[\s-]?)?ear|over[\s-]the[\s-]ear|wh-\d|wh-?1000)\b/i;
const IN_EAR = /\b(ear ?buds?|in-ear|true wireless|tws|wf-\d|wf-?1000)\b/i;
function typesOf(t: string): string[] { const out: string[] = []; for (const [k, rx] of TYPE_RX) if (rx.test(t)) out.push(k); return out; }
/** Product type from the TITLE first (URLs often carry a category like /headphones/ for earbuds); the URL is used only when the title says nothing.
 * Over-ear vs earbuds: explicit form-factor words or model prefixes (Sony WH- = over-ear, WF- = earbuds) win. */
export function productTypes(text: string, url = ""): string[] {
  const title = text.toLowerCase();
  let out = typesOf(title);
  if (!out.length && url) out = typesOf(url.toLowerCase().replace(/[-_/]+/g, " "));
  const over = OVER_EAR.test(title), inear = IN_EAR.test(title);
  if (out.includes("earbuds") && out.includes("headphones") && !out.includes("bundle")) {
    if (over && !/\b(ear ?buds?|wf-\d|true wireless|tws)\b/i.test(title)) out = out.filter((x) => x !== "earbuds");
    else if (inear && !over) out = out.filter((x) => x !== "headphones");
  }
  if (over && !out.includes("headphones")) { out = out.filter((x) => x !== "earbuds" || inear); out.push("headphones"); }
  return [...new Set(out)];
}

const STOP: Set<string> = new Set(["the", "anc", "over-ear", "on-ear", "for", "and", "with", "under", "best", "cheap", "new", "used", "manual", "electric", "noise", "wireless", "over", "coffee", "gift", "headphones", "earbuds", "bluetooth", "cheapest"]);
const fold = (s: string) => s.toLowerCase().replace(/0/g, "o").replace(/[1|]/g, "l").replace(/5/g, "s").replace(/3/g, "e").replace(/4/g, "a").replace(/@/g, "a");
/** The brand whose own store this is (bose.com, us.soundcore.com, skullcandy.ae, edifier-online.com), else null. */
export function brandStoreOf(host: string): string | null {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  for (const l of labels.slice(0, -1)) {
    if (KNOWN.has(l)) return l;
    const base = l.replace(/-?(online|usa|us|shop|store|official|global)$/, "");
    if (base !== l && KNOWN.has(base)) return base;
  }
  return null;
}
/** Known brands: a starter list plus brand words from our offers and brand store domains. Only these count as a query brand. */
const KNOWN = new Set<string>(["bose", "sony", "apple", "samsung", "sennheiser", "skullcandy", "jbl", "beats", "anker", "soundcore", "audio-technica", "jabra", "marshall", "edifier", "sonos", "shure", "akg", "beyerdynamic",
  "baratza", "fellow", "breville", "hario", "timemore", "kinu", "comandante", "1zpresso", "wacaco", "turin", "eureka", "rancilio", "trezor", "ledger", "coldcard", "bitbox", "chanel", "hermes", "gucci", "prada", "vuitton", "jlab", "raycon", "wyze", "heavys", "kaffe", "cowin"]);
export function addKnownBrands(words: Iterable<string>) { for (const w of words) { const x = w.toLowerCase(); if (/^[a-z][a-z0-9&-]{2,}$/.test(x) && !STOP.has(x)) KNOWN.add(x); } }
/** The brand a query names (exact or written with look-alike characters such as "B0SE"). */
export function queryBrand(query: string | undefined): { brand: string; written: string; lookalike: boolean } | null {
  if (!query) return null;
  for (const w of query.trim().split(/\s+/)) {
    const lw = w.toLowerCase().replace(/[^a-z0-9&|@-]/g, "");
    if (!lw || STOP.has(lw)) continue;
    if (KNOWN.has(lw)) return { brand: lw, written: w, lookalike: false };
    const f = fold(lw);
    if (f !== lw && KNOWN.has(f)) return { brand: f, written: w, lookalike: true };
  }
  return null;
}
/** brand_match: ok (title, the row's brand field, or the brand's own store), lookalike (B0SE for Bose in the title), absent (a brand
 * was asked for and the row doesn't show it), null (the query names no known brand). A look-alike query is flagged in brand_note. */
export function brandCheck(query: string | undefined, title: string, domain = "", rowBrand: string | null = null): { brand_match: "ok" | "lookalike" | "absent" | null; brand?: string | null; brand_src?: string; brand_note?: string; query_lookalike?: string } {
  const qb = queryBrand(query);
  const host = domain.replace(/^www\./, "");
  const ownBrand = host.split(".").find((p) => KNOWN.has(p)) ?? null;
  const words = title.split(/[^A-Za-z0-9&|@-]+/).filter(Boolean);
  const titleBrand = words.find((w) => KNOWN.has(w.toLowerCase()))?.toLowerCase() ?? null;
  const rb = rowBrand?.split(/\s+/)[0]?.toLowerCase() || null;
  const brand = rb || titleBrand || ownBrand;
  const brandSrc = rb ? "store's structured data" : titleBrand ? "title" : ownBrand ? "the brand's own store domain" : undefined;
  const base = { brand: brand ?? null, ...(brandSrc ? { brand_src: brandSrc } : {}), ...(qb?.lookalike ? { query_lookalike: `the query writes "${qb.written}", a look-alike spelling of "${qb.brand}"` } : {}) };
  if (!qb) return { brand_match: null, ...base };
  const look = words.find((w) => fold(w) === qb.brand && w.toLowerCase() !== qb.brand);
  if (look) return { brand_match: "lookalike", ...base, brand_note: `title spells the brand "${look}" (look-alike characters for "${qb.brand}"); likely not genuine` };
  if (brand === qb.brand || words.some((w) => w.toLowerCase() === qb.brand)) return { brand_match: "ok", ...base };
  return { brand_match: "absent", ...base, brand_note: `"${qb.brand}" is not in the title, the row's brand or the store domain` };
}

/** Model-number tokens in the query (contain a digit and >=4 chars), matched against title+url. */
export function modelMatch(query: string | undefined, text: string): string | null {
  if (!query) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const toks = query.split(/\s+/).filter((t) => /\d/.test(t) && norm(t).length >= 4);
  const nt = norm(text);
  const hit = toks.find((t) => nt.includes(norm(t)));
  return hit ?? null;
}

const COLOURS = /\b(black|white|cream|silver|blue|navy|midnight|red|pink|green|sage|mauve|grey|gray|beige|sandstone|smoke|true|platinum|gold|rose|purple|lilac|mint|ivory|charcoal|graphite|tan|brown|cream white|true black)\b/g;
/** Same product, different listing: colour words, "bundle" and bracketed text removed, tokens sorted. */
export function productKey(title: string): string {
  const t = title.toLowerCase().replace(/[®™©]/g, "").replace(/\([^)]*\)/g, " ").replace(COLOURS, " ").replace(/\b(bundle|with case|kit)\b/g, " ");
  return [...new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 1))].sort().join(" ");
}
/** Dedupe rows by store + product (URL path without query, else normalized title). Keeps the first (cheapest after sort). */
export function dedupe<T extends Record<string, any>>(rows: T[]): { rows: T[]; removed: number } {
  const seen = new Set<string>(); const out: T[] = [];
  const byKey = new Map<string, any>(), byKey3 = new Map<string, any>();
  for (const r of rows) {
    const d = String(r.domain ?? r.d ?? "").replace(/^www\./, "");
    let k = "";
    try { k = r.url ? new URL(String(r.url)).pathname.replace(/\/$/, "") : ""; } catch { /* */ }
    // Same store + same product page = one row (colour/size variants collapse; the cheapest comes first after sort).
    // Gift-card denominations share a page, so they are told apart by face value.
    const denom = r.denomination?.face_usd ?? (r.sku && /:\d+(\.\d+)?$/.test(String(r.sku)) ? String(r.sku) : "");
    const key = `${d}|${k || String(r.title ?? r.name ?? "").toLowerCase().replace(/\W+/g, " ").trim()}|${denom}`;
    const key2 = `${d}|${String(r.title ?? r.name ?? "").toLowerCase().replace(/\W+/g, " ").trim()}|${denom || (r.price ?? "")}`;
    // Same store, same product, same price under different handles (colour pages, accessory bundles at the same price) = one row,
    // with the other listings kept as URLs so nothing is hidden.
    const pk = productKey(String(r.title ?? r.name ?? ""));
    const key3 = denom || pk.split(" ").length < 2 ? "" : `${d}|${pk}|${r.price ?? ""}`;
    const first = (key3 && byKey3.get(key3)) || (seen.has(key) || seen.has(key2) ? byKey.get(key) ?? byKey.get(key2) : undefined);
    if (first) { (first.other_listings ??= []).push(String(r.url ?? "")); continue; }
    if (seen.has(key) || seen.has(key2)) continue;
    seen.add(key); seen.add(key2); out.push(r); byKey.set(key, r); byKey.set(key2, r); if (key3) byKey3.set(key3, r);
  }
  return { rows: out, removed: rows.length - out.length };
}

/** Annotate one row (indexed or live) in place-free fashion. */
export function annotate<T extends Record<string, any>>(row: T, q: string | undefined): T & Record<string, unknown> {
  const title = String(row.title ?? row.name ?? "");
  const text = `${title} ${row.variant ?? ""} ${row.url ?? ""}`;
  const c0 = conditionOf(text, String(row.domain ?? row.d ?? ""));
  // The store's own structured data (schema.org itemCondition) beats "not stated" in the title.
  const sd = typeof row.condition === "string" && (CONDITIONS as readonly string[]).includes(row.condition);
  const c = sd && c0.condition_src !== "listing title/url" ? { condition: row.condition as Condition, condition_src: "store's structured data (itemCondition)" } : c0;
  const basis = c.condition === null ? "unknown" : c.condition_src === "listing title/url" || c.condition_src.startsWith("store's structured") ? "stated" : "inferred";
  const mm = modelMatch(q, text);
  return { ...row, ...c, condition_basis: basis, ...(row.source === "shopify-catalog-live" ? relevanceOf(q, title) : {}), product_type: productTypes(title, String(row.url ?? "")), ...brandCheck(q, title, String(row.domain ?? row.d ?? ""), typeof row.brand === "string" ? row.brand : null), ...(mm ? { match: { by: "model", token: mm } } : {}) };
}

export function applyProductFilters<T extends Record<string, any>>(rows: T[], f: { condition?: string; type?: string; brand_strict?: boolean }) {
  let dropped = 0, unknownDropped = 0;
  const out = rows.filter((r) => {
    if (f.condition) {
      const want = f.condition.split(",");
      // "unknown" is its own option: condition=new keeps stated or inferred new only; condition=new,unknown also keeps unstated rows.
      if (!want.includes(r.condition ?? "unknown")) { dropped++; if (r.condition == null) unknownDropped++; return false; }
    }
    if (f.type && !(r.product_type ?? []).some((t: string) => f.type!.split(",").includes(t))) { dropped++; return false; }
    if (f.brand_strict && r.brand_match !== "ok" && r.brand_match !== null) { dropped++; return false; } // strict: look-alikes and rows without the brand are out
    return true;
  });
  return { rows: out, dropped, condition_unknown_dropped: unknownDropped };
}

const REL_STOP = new Set(["the", "a", "an", "for", "and", "with", "under", "best", "cheap", "cheapest", "buy", "of", "in", "to", "on"]);
const SYN: Record<string, string> = { cancelling: "cancel", canceling: "cancel", cancellation: "cancel", cancel: "cancel", anc: "cancel", nc: "cancel", headphone: "headphones", headphones: "headphones", earbud: "earbuds", earbuds: "earbuds", grinders: "grinder", mill: "grinder" };
const relToks = (s: string) => s.toLowerCase().replace(/[®™©]/g, "").split(/[^a-z0-9]+/).filter((w) => w && !REL_STOP.has(w)).map((w) => SYN[w] ?? w.replace(/s$/, ""));
/** Relevance of a live row to the query: share of query words in the title (synonyms folded). Below the floor = not one
 * word of the query matches except bare numbers, so "Hesh 540" does not return perfume named "540". Rows are dropped below it. */
export function relevanceOf(query: string | undefined, title: string): { relevance: number; below_floor: boolean } {
  const q = query ? [...new Set(relToks(query))] : [];
  if (!q.length) return { relevance: 1, below_floor: false };
  const tt = new Set(relToks(title));
  const hit = q.filter((w) => tt.has(w));
  const words = q.filter((w) => /[a-z]/.test(w));
  const rel = Math.round((hit.length / q.length) * 100) / 100;
  return { relevance: rel, below_floor: hit.length === 0 || (words.length > 0 && !hit.some((w) => /[a-z]/.test(w))) };
}
