import { ALT_PAY_FILTERS, COARSE_CATEGORIES, SUBCATEGORIES } from "./vocab";
export { COARSE_CATEGORIES, SUBCATEGORIES };
import { storeFacts } from "./explain";
const pickAlt = (f: ReturnType<typeof storeFacts>) => ({ agent_access: f.agent_access, checkout: f.checkout, guest: f.guest, btc_grade: f.btc_grade });
/** CASCADE GO 5.6: "Where else can my agent buy this?" Index-only; never crawls. */
import type { IndexRow, Snapshot } from "./index-mem";
import { parseRaw } from "./records-api";
import { CATEGORY_MAP } from "./category-map";
import { whyOf, deriveVerdict } from "./explain";
import { AN_ALT_CATEGORIES, anCategories, anJson } from "./agent-native";

/** GO 5.7 finer subcategories (signed in v3 records as `sub`). Product words map to a sub first, then a coarse category. */
const SUB_SYNONYMS: [RegExp, string, string][] = [
  [/head ?phone|earbud|ear ?phone|speaker|sound ?bar|audio|headset|hi-?fi|turntable/i, "audio", "electronics"],
  [/laptop|notebook|desktop|computer|\bpc\b|monitor|macbook|chromebook|keyboard|mouse/i, "computers", "electronics"],
  [/smart ?phone|\bphone|iphone|pixel|galaxy/i, "phones", "electronics"],
  [/\btv\b|television|projector|streaming (stick|device)|blu-?ray/i, "tv-video", "electronics"],
  [/camera|lens|drone|gopro|action cam/i, "cameras", "electronics"],
  [/console|video ?game|playstation|xbox|nintendo|switch 2|gaming/i, "gaming", "electronics"],
  [/smart ?watch|fitness tracker|wearable|\bwatch\b/i, "wearables", "electronics"],
  [/doorbell|thermostat|smart ?home|security cam|smart (plug|bulb|lock)/i, "smart-home", "electronics"],
  [/vacuum|appliance|fridge|refrigerator|washer|dryer|microwave|air purifier|dishwasher/i, "appliances", "electronics"],
  [/router|wi-?fi|mesh|modem|network/i, "networking", "electronics"],
  [/charger|cable|power ?bank|adapter|case\b/i, "accessories", "electronics"],
  [/hand ?bags?|purses?|\btotes?\b|clutch|crossbody|designer bag|luxury bag|birkin|satchel/i, "handbags", "apparel"],
];
export const MAJOR_RETAILERS = new Set(["amazon.com", "walmart.com", "target.com", "costco.com", "samsclub.com", "bestbuy.com", "newegg.com", "bhphotovideo.com", "ebay.com", "homedepot.com", "lowes.com", "macys.com", "kohls.com", "staples.com", "officedepot.com"]);

export function resolveSub(input: string): { sub: string; category: string } | null {
  const s = input.trim().toLowerCase();
  if ((SUBCATEGORIES as readonly string[]).includes(s)) return { sub: s, category: s === "gift-cards" ? "gift-cards" : s === "handbags" ? "apparel" : "electronics" };
  for (const [rx, sub, category] of SUB_SYNONYMS) if (rx.test(input)) return { sub, category };
  return null;
}
export function subsFor(raw: Record<string, unknown>): string[] {
  return Array.isArray(raw.sub) ? (raw.sub as string[]) : [];
}

const PAY_FILTER: Record<string, string[]> = ALT_PAY_FILTERS;
const SYNONYMS: [RegExp, string][] = [
  [/noise.?cancel|\banc\b|over.?ear|headphone|earbud|laptop|phone|tv|camera|electronic|speaker|monitor/i, "electronics"],
  [/gift ?card|voucher|top.?up|refill/i, "gift-cards"],
  [/grocer|food|snack/i, "groceries"],
  [/shirt|shoe|cloth|apparel|jacket|hoodie|fashion|designer/i, "apparel"],
  [/tool|hardware store|lumber|drill|paint|auto part/i, "hardware"],
  [/book/i, "books"],
  [/flight|hotel|travel|ticket/i, "travel"],
  [/hardware wallet|seed|signing device|node|crypto hardware|coldcard|trezor|ledger/i, "crypto-hardware"],
];

export function categoriesFor(d: string, raw?: Record<string, unknown>): string[] {
  const own = Array.isArray(raw?.category) ? (raw!.category as string[]) : null;
  const base = own ?? CATEGORY_MAP.map[d] ?? ["other"];
  const an = anCategories(d);
  if (!an.length) return base;
  return [...new Set([...base.filter((c) => c !== "other"), ...an])];
}

export function resolveCategory(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "-");
  if (s in AN_ALT_CATEGORIES) return s;
  if ((COARSE_CATEGORIES as readonly string[]).includes(s)) return s;
  for (const [rx, c] of SYNONYMS) if (rx.test(input)) return c;
  return null;
}

export interface AltParams { domain?: string; category?: string; sub?: string; pay?: string; guest?: boolean; limit?: number; include_indirect?: boolean; include_blocked?: boolean }

export function findAlternatives(snap: Snapshot, origin: string, p: AltParams) {
  let cats: string[] = [];
  let from: string | null = null;
  let sub: string | null = null;
  const subIn = p.sub ?? p.category;
  if (subIn) {
    const rs = resolveSub(subIn);
    if (rs) { sub = rs.sub; cats = [rs.category]; }
    else if (p.sub) return { ok: false as const, message: `unknown sub; use one of ${SUBCATEGORIES.join(", ")} or a product word like headphones` };
  }
  if (p.category && !cats.length) {
    const c = resolveCategory(p.category);
    if (!c) return { ok: true as const, body: { from: p.domain ?? null, categories: [] as string[], sub: null, filters: { pay: p.pay ?? null, guest: !!p.guest }, count: 0, total: 0, items: [] as never[], turned_away: [] as never[], turned_away_note: "",
      note: `We have no category for "${p.category}" yet, so there are no alternatives to list. Use one of valid_categories or a product word like headphones.`,
      valid_categories: [...new Set([...COARSE_CATEGORIES, ...Object.keys(AN_ALT_CATEGORIES)])], valid_subs: [...SUBCATEGORIES] } };
    cats = [c];
  }
  if (p.domain) {
    from = p.domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
    const row = snap.rows.find((r) => r.d === from || r.d === from!.replace(/^www\./, ""));
    if (!cats.length) cats = row ? categoriesFor(row.d, parseRaw(row.raw_json)) : [];
    if (!cats.length) return { ok: false as const, message: `${from} is not in the index; pass category= too` };
  }
  if (!cats.length) return { ok: false as const, message: "pass domain= or category=" };
  if (p.pay) p = { ...p, pay: p.pay.trim().toLowerCase() };
  if (p.pay && !PAY_FILTER[p.pay]) return { ok: false as const, message: `pay must be one of ${Object.keys(ALT_PAY_FILTERS).join(", ")} (btc/onchain/btc-onchain = on-chain only; bitcoin = on-chain or Lightning)` };
  const want = p.pay ? PAY_FILTER[p.pay]! : null;
  const rows: { row: IndexRow; raw: Record<string, unknown>; pays: string[]; subRank: number; indirect: boolean; blocked: boolean }[] = [];
  const blockedExcluded: string[] = [];
  const wantsBtc = !!want && want.some((x) => ["btc", "ln", "lnurl", "bolt12"].includes(x));
  const indirectExcluded: string[] = [];
  const turnedAway: { d: string; name: string | null; status: string; reason: string | null; record: string }[] = [];
  for (const row of snap.rows) {
    if (row.d === from) continue;
    const raw = parseRaw(row.raw_json);
    const rc = categoriesFor(row.d, raw);
    if (!rc.some((c) => cats.includes(c))) continue;
    const subs = subsFor(raw);
    if (subs.includes("wholesale") && sub !== "wholesale") continue; // B2B (e.g. alibaba.com) is not a consumer alternative
    if (sub && subs.length && !subs.includes(sub)) continue; // known product families that exclude it; unknown (no sub yet) is kept, ranked lower
    const subRank = sub ? (subs[0] === sub ? 2 : subs.includes(sub) ? 1 : 0) : 0;
    if (row.status !== "crawled") {
      turnedAway.push({ d: row.d, name: row.name, status: row.status, reason: whyOf(raw)?.msg ?? null, record: `${origin}/records/${encodeURIComponent(row.d)}` });
      continue;
    }
    // R11-001: a crawled store whose checkout is blocked (bot wall, refused) is not an alternative unless include_blocked=1; then it ranks last.
    const blocked = deriveVerdict(row, raw).verdict === "checkout-blocked";
    if (blocked && !p.include_blocked) { blockedExcluded.push(row.d); continue; }
    const pays = [...new Set([...(raw.pay as string[] ?? []), ...(raw.pay_online as string[] ?? [])])];
    // Stores that take bitcoin only through a processor (btc_indirect) stay in bitcoin results, labelled and ranked after native ones.
    const indirect = wantsBtc && !pays.some((x) => want!.includes(x)) && Array.isArray(raw.btc_indirect) && (raw.btc_indirect as unknown[]).length > 0;
    if (want && !pays.some((x) => want.includes(x)) && !indirect) continue;
    // pay=btc means the store's own checkout takes bitcoin. Indirect-only stores appear only when asked for (include_indirect=1).
    if (indirect && !p.include_indirect) { indirectExcluded.push(row.d); continue; }
    if (p.guest && row.guest === 0) continue; // account required: excluded; unknown kept but ranked lower
    rows.push({ row, raw, pays, subRank, indirect, blocked });
  }
  const n = (v: number | null | undefined) => (v === null || v === undefined ? -1 : v);
  const maj = (d: string) => (MAJOR_RETAILERS.has(d) ? 1 : 0);
  const restricted = (raw: Record<string, unknown>) => (raw.agent_policy ? 1 : 0);
  rows.sort((a, b) =>
    Number(a.blocked) - Number(b.blocked) // checkout-blocked last (only present with include_blocked=1)
    || Number(a.indirect) - Number(b.indirect) // native bitcoin before processor-only
    || n(b.row.co) - n(a.row.co) // reaches checkout first
    || restricted(a.raw) - restricted(b.raw) // terms restrict agent orders: after equals
    || maj(b.row.d) - maj(a.row.d) // major retailers among equals
    || b.subRank - a.subRank // the product family is the store's main line
    || n(b.row.ag) - n(a.row.ag)
    || (p.guest ? n(b.row.guest) - n(a.row.guest) : 0)
    || n(b.row.btc) - n(a.row.btc)
    || n(b.row.ease) - n(a.row.ease)
    || a.row.d.localeCompare(b.row.d));
  const items = rows.slice(0, Math.min(50, p.limit ?? 10)).map(({ row, raw, pays, subRank, indirect, blocked }) => {
    const pq = Array.isArray(raw.pay_q) ? (raw.pay_q as { c: string; url: string }[]) : [];
    const ev = (want && pq.find((q) => want.includes(q.c))?.url) || (Array.isArray(raw.evu) ? (raw.evu as string[])[0] : null) || `https://${row.d}/`;
    return {
      d: row.d, name: row.name, url: `https://${row.d}/`, verdict: blocked ? "checkout-blocked" : "reachable", categories: categoriesFor(row.d, raw),
      sub: subsFor(raw), sub_match: sub ? (subRank === 2 ? "main line" : subRank === 1 ? "carries it" : "unknown") : null, major_retailer: MAJOR_RETAILERS.has(row.d),
      agent_ordering: raw.agent_policy ? (raw.agent_policy as { v: string }).v : null,
      ...pickAlt(storeFacts(row)), ease: row.ease,
      pay: pays, ...(wantsBtc ? { btc_route: indirect ? "indirect" : "native", ...(indirect ? { btc_indirect: raw.btc_indirect, btc_note: (raw.btc_indirect as { kind?: string }[]).every((x) => x.kind === "gift-card") ? "bitcoin only by buying the store's gift card at a reseller (e.g. Bitrefill) and paying with the card" : "bitcoin only through a third-party processor, not paid to the store's own wallet" } : {}) } : {}), evidence: ev, record: `${origin}/records/${encodeURIComponent(row.d)}`,
      ...(anJson(row.d) ? { agent_native: anJson(row.d) } : {}),
    };
  });
  return {
    ok: true as const,
    body: {
      from, categories: cats, sub, filters: { pay: p.pay ?? null, guest: !!p.guest, ...(wantsBtc ? { include_indirect: !!p.include_indirect } : {}) }, count: items.length, total: rows.length,
      ...(sub && !rows.some((r) => r.subRank > 0) ? { sub_note: `No indexed store is tagged as selling ${sub} yet. ${rows.length ? `These are ${cats.join("/")} stores whose product families are not recorded; they may not carry ${sub}.` : ""}${sub === "handbags" ? " Luxury and designer resale stores are not indexed yet (many ban automated access in their terms)." : ""}`.trim() } : {}),
      ...(wantsBtc ? { btc_semantics: "pay filters match native acceptance (the store's own checkout takes bitcoin/Lightning). Stores where bitcoin works only through a third-party processor or a gift card are excluded unless include_indirect=1, then labelled btc_route=indirect and ranked last.",
        indirect_excluded: p.include_indirect ? [] : indirectExcluded, ...(indirectExcluded.length && !p.include_indirect ? { indirect_hint: `${indirectExcluded.length} store(s) take bitcoin only indirectly (${indirectExcluded.join(", ")}); add include_indirect=1 to list them` } : {}) } : {}),
      ranking: "checkout reached (co) desc, terms-restricted stores after equals, major retailer first among equals, product family is the store's main line, agent access (ag) desc, guest confirmed (if guest=1), BTC grade desc, ease desc",
      note: "Store-level, not product-level: a match means the store sells that product family (signed `sub` in v0.4 records), not that a specific item is in stock. guest=1 excludes stores known to require an account; unknown guest status is kept and marked null. B2B wholesale stores are excluded.",
      items,
      include_blocked: !!p.include_blocked, blocked_excluded: p.include_blocked ? [] : blockedExcluded.slice(0, 20),
      ...(blockedExcluded.length && !p.include_blocked ? { blocked_hint: `${blockedExcluded.length} store(s) in this category have checkout blocked (bot wall or refusal); add include_blocked=1 to list them last.` } : {}),
      turned_away: turnedAway.slice(0, 10),
      turned_away_note: "Stores in the same category/sub that refuse agents or could not be read; listed so you know they exist, not as options.",
    },
  };
}
