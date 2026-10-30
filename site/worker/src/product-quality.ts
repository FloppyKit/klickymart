/** Product-level quality signals for offers (indexed and live): condition, product type, brand look-alikes,
 * model-number match, and dedupe by store + product. Pure functions; nothing is stored. */
export const CONDITIONS = ["new", "refurbished", "open-box", "used"] as const;
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
  return { condition: null, condition_src: "not stated in the listing (most new items don't say)" };
}

const TYPE_RX: [string, RegExp][] = [
  ["gift-card", /\bgift[\s-]?cards?\b|\be-?gift\b/],
  ["bundle", /\b(bundle|set|\+)\b|\bset-/],
  ["earbuds", /\b(ear ?buds?|in-ear|true wireless|tws)\b/],
  ["headset", /\b(headset|gaming headset)\b/],
  ["headphones", /\b(headphones?|over-ear|on-ear|cans)\b/],
  ["speaker", /\b(speaker|soundbar|sound bar)\b/],
  ["grinder", /\bgrinder\b/],
  ["accessory", /\b(case|cable|cushion|ear ?pads?|charger|adapter|stand|replacement)\b/],
];
export function productTypes(text: string): string[] {
  const t = text.toLowerCase(); const out: string[] = [];
  for (const [k, rx] of TYPE_RX) if (rx.test(t)) out.push(k);
  return out;
}

const fold = (s: string) => s.toLowerCase().replace(/0/g, "o").replace(/[1|]/g, "l").replace(/5/g, "s").replace(/3/g, "e").replace(/4/g, "a").replace(/@/g, "a");
/** Flags a title that spells a query brand with look-alike characters (e.g. "B0SE" for "Bose"), or omits the brand. */
export function brandCheck(query: string | undefined, title: string, domain = ""): { brand_match: "ok" | "lookalike" | "absent" | null; brand_note?: string } {
  if (!query) return { brand_match: null };
  const brand = query.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!/^[a-z][a-z&-]{2,}$/.test(brand) || STOP.has(brand)) return { brand_match: null };
  const words = title.split(/[^A-Za-z0-9&|@-]+/).filter(Boolean);
  if (words.some((w) => w.toLowerCase() === brand)) return { brand_match: "ok" };
  if (domain.replace(/^www\./, "").split(".").some((p) => p === brand)) return { brand_match: "ok", brand_note: "sold on the brand's own store" };
  const look = words.find((w) => fold(w) === brand && w.toLowerCase() !== brand);
  if (look) return { brand_match: "lookalike", brand_note: `title spells the brand "${look}" (look-alike characters for "${brand}"); likely not genuine` };
  return { brand_match: "absent", brand_note: `"${brand}" does not appear in the title` };
}
const STOP = new Set(["the", "best", "cheap", "new", "used", "manual", "electric", "noise", "wireless", "over", "coffee", "gift", "headphones", "earbuds", "bluetooth", "cheapest"]);

/** Model-number tokens in the query (contain a digit and >=4 chars), matched against title+url. */
export function modelMatch(query: string | undefined, text: string): string | null {
  if (!query) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const toks = query.split(/\s+/).filter((t) => /\d/.test(t) && norm(t).length >= 4);
  const nt = norm(text);
  const hit = toks.find((t) => nt.includes(norm(t)));
  return hit ?? null;
}

/** Dedupe rows by store + product (URL path without query, else normalized title). Keeps the first (cheapest after sort). */
export function dedupe<T extends Record<string, any>>(rows: T[]): { rows: T[]; removed: number } {
  const seen = new Set<string>(); const out: T[] = [];
  for (const r of rows) {
    const d = String(r.domain ?? r.d ?? "").replace(/^www\./, "");
    let k = "";
    try { k = r.url ? new URL(String(r.url)).pathname.replace(/\/$/, "") : ""; } catch { /* */ }
    const key = `${d}|${k || String(r.title ?? r.name ?? "").toLowerCase().replace(/\W+/g, " ").trim()}|${r.variant ?? ""}`;
    const key2 = `${d}|${String(r.title ?? r.name ?? "").toLowerCase().replace(/\W+/g, " ").trim()}|${r.price ?? ""}`;
    if (seen.has(key) || seen.has(key2)) continue;
    seen.add(key); seen.add(key2); out.push(r);
  }
  return { rows: out, removed: rows.length - out.length };
}

/** Annotate one row (indexed or live) in place-free fashion. */
export function annotate<T extends Record<string, any>>(row: T, q: string | undefined): T & Record<string, unknown> {
  const title = String(row.title ?? row.name ?? "");
  const text = `${title} ${row.variant ?? ""} ${row.url ?? ""}`;
  const c = conditionOf(text, String(row.domain ?? row.d ?? ""));
  const mm = modelMatch(q, text);
  return { ...row, ...c, product_type: productTypes(`${title} ${row.url ?? ""}`), ...brandCheck(q, title, String(row.domain ?? row.d ?? "")), ...(mm ? { match: { by: "model", token: mm } } : {}) };
}

export function applyProductFilters<T extends Record<string, any>>(rows: T[], f: { condition?: string; type?: string; brand_strict?: boolean }) {
  let dropped = 0;
  const out = rows.filter((r) => {
    if (f.condition) {
      const want = f.condition.split(",");
      const c = r.condition ?? (want.includes("new") && !r.condition ? "new?" : null);
      if (!(want.includes(r.condition) || (c === "new?" && want.includes("new")))) { dropped++; return false; }
    }
    if (f.type && !(r.product_type ?? []).some((t: string) => f.type!.split(",").includes(t))) { dropped++; return false; }
    if (f.brand_strict && r.brand_match === "lookalike") { dropped++; return false; }
    return true;
  });
  return { rows: out, dropped };
}
