/** CASCADE GO 5.6: "Where else can my agent buy this?" Index-only; never crawls. */
import type { IndexRow, Snapshot } from "./index-mem";
import { parseRaw } from "./records-api";
import { CATEGORY_MAP } from "./category-map";

export const COARSE_CATEGORIES = ["electronics", "gift-cards", "groceries", "apparel", "hardware", "books", "travel", "crypto-hardware", "other"] as const;
const PAY_FILTER: Record<string, string[]> = { lightning: ["ln", "lnurl", "bolt12"], btc: ["btc", "ln", "lnurl", "bolt12"], cashu: ["cashu"] };
const SYNONYMS: [RegExp, string][] = [
  [/headphone|earbud|laptop|phone|tv|camera|electronic|speaker|monitor/i, "electronics"],
  [/gift ?card|voucher|top.?up|refill/i, "gift-cards"],
  [/grocer|food|snack/i, "groceries"],
  [/shirt|shoe|cloth|apparel|jacket|hoodie|fashion/i, "apparel"],
  [/tool|hardware store|lumber|drill|paint|auto part/i, "hardware"],
  [/book/i, "books"],
  [/flight|hotel|travel|ticket/i, "travel"],
  [/hardware wallet|seed|signing device|node|crypto hardware|coldcard|trezor|ledger/i, "crypto-hardware"],
];

export function categoriesFor(d: string, raw?: Record<string, unknown>): string[] {
  const own = Array.isArray(raw?.category) ? (raw!.category as string[]) : null;
  return own ?? CATEGORY_MAP.map[d] ?? ["other"];
}

export function resolveCategory(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "-");
  if ((COARSE_CATEGORIES as readonly string[]).includes(s)) return s;
  for (const [rx, c] of SYNONYMS) if (rx.test(input)) return c;
  return null;
}

export interface AltParams { domain?: string; category?: string; pay?: string; guest?: boolean; limit?: number }

export function findAlternatives(snap: Snapshot, origin: string, p: AltParams) {
  let cats: string[] = [];
  let from: string | null = null;
  if (p.category) {
    const c = resolveCategory(p.category);
    if (!c) return { ok: false as const, message: `unknown category; use one of ${COARSE_CATEGORIES.join(", ")} or a product word like headphones` };
    cats = [c];
  }
  if (p.domain) {
    from = p.domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!;
    const row = snap.rows.find((r) => r.d === from || r.d === from!.replace(/^www\./, ""));
    if (!cats.length) cats = row ? categoriesFor(row.d, parseRaw(row.raw_json)) : [];
    if (!cats.length) return { ok: false as const, message: `${from} is not in the index; pass category= too` };
  }
  if (!cats.length) return { ok: false as const, message: "pass domain= or category=" };
  if (p.pay && !PAY_FILTER[p.pay]) return { ok: false as const, message: "pay must be lightning, btc or cashu" };
  const want = p.pay ? PAY_FILTER[p.pay]! : null;
  const rows: { row: IndexRow; raw: Record<string, unknown>; pays: string[] }[] = [];
  for (const row of snap.rows) {
    if (row.d === from || row.status !== "crawled") continue;
    const raw = parseRaw(row.raw_json);
    const rc = categoriesFor(row.d, raw);
    if (!rc.some((c) => cats.includes(c))) continue;
    const pays = [...new Set([...(raw.pay as string[] ?? []), ...(raw.pay_online as string[] ?? [])])];
    if (want && !pays.some((x) => want.includes(x))) continue;
    if (p.guest && row.guest === 0) continue; // account required: excluded; unknown kept but ranked lower
    rows.push({ row, raw, pays });
  }
  const n = (v: number | null | undefined) => (v === null || v === undefined ? -1 : v);
  rows.sort((a, b) =>
    n(b.row.co) - n(a.row.co) // reaches checkout first
    || n(b.row.ag) - n(a.row.ag)
    || (p.guest ? n(b.row.guest) - n(a.row.guest) : 0)
    || n(b.row.btc) - n(a.row.btc)
    || n(b.row.ease) - n(a.row.ease)
    || a.row.d.localeCompare(b.row.d));
  const items = rows.slice(0, Math.min(50, p.limit ?? 10)).map(({ row, raw, pays }) => {
    const pq = Array.isArray(raw.pay_q) ? (raw.pay_q as { c: string; url: string }[]) : [];
    const ev = (want && pq.find((q) => want.includes(q.c))?.url) || (Array.isArray(raw.evu) ? (raw.evu as string[])[0] : null) || `https://${row.d}/`;
    return {
      d: row.d, name: row.name, url: `https://${row.d}/`, categories: categoriesFor(row.d, raw),
      agent_access: row.ag, checkout: row.co, guest: row.guest === null ? null : row.guest === 1, btc_grade: row.btc, ease: row.ease,
      pay: pays, evidence: ev, record: `${origin}/records/${encodeURIComponent(row.d)}`,
    };
  });
  return {
    ok: true as const,
    body: {
      from, categories: cats, filters: { pay: p.pay ?? null, guest: !!p.guest }, count: items.length, total: rows.length,
      ranking: "checkout reached (co) desc, agent access (ag) desc, guest confirmed (if guest=1), BTC grade desc, ease desc",
      note: "Categories are a coarse draft (category-map 2026-10-29), not yet in signed records. guest=1 excludes stores known to require an account; unknown guest status is kept and marked null.",
      items,
    },
  };
}
