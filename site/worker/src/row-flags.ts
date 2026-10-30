/** Per-row buyability flags for product results: can an agent use this store, and is anything about the row suspect?
 * Drives the ranking (usable stores first) and the one-line text summary. Pure; nothing is stored. */
type Row = Record<string, any>;

const NOT_USABLE: Record<string, string> = {
  "blocked-tos": "the store's terms ban automated access: KlickyMart does not crawl it and an agent should not order there",
  "agents-not-welcome": "the store refuses agents (robots.txt or an explicit block)",
  "error": "the store could not be read (network or server error)",
};
const BLOCKER_FLAGS: Record<string, string> = {
  "no-add-to-cart": "our guest probe found no add-to-cart button on this store's product page: an agent may not get past the product page",
  "no-checkout-button": "our guest probe could not find a checkout button in the cart",
  "bot-wall": "a bot wall stopped our guest probe",
  "login-wall": "the store requires an account to check out",
};

export function rowFlags(r: Row): { agent_usable: boolean | null; store_status: string; flags: string[] } {
  const st = r.store ?? {};
  const flags: string[] = [];
  let usable: boolean | null;
  let status: string;
  if (st.indexed === false || !st.verdict) { status = "not-indexed"; usable = null; flags.push("store not checked yet: robots, terms and checkout facts unknown"); }
  else {
    status = String(st.verdict);
    if (NOT_USABLE[status]) { usable = false; flags.push(`${status}: ${NOT_USABLE[status]}`); }
    else usable = true;
    const fb = st.first_blocker as string | null | undefined;
    if (usable && fb && BLOCKER_FLAGS[fb]) { flags.push(`${fb}: ${BLOCKER_FLAGS[fb]}`); if (fb === "login-wall") usable = false; }
  }
  if (r.brand_match === "lookalike") flags.push("brand look-alike spelling: likely not genuine");
  if (r.price_flag) flags.push(String(r.price_flag));
  return { agent_usable: usable, store_status: status, flags };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
/** Flag prices far below comparable rows in the same result (same product type, USD): under 20% of the median of 4+ rows. */
export function flagPriceOutliers(rows: Row[]): number {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.currency && r.currency !== "USD") continue;
    if (typeof r.price !== "number" || (r.product_type ?? []).includes("gift-card") || (r.product_type ?? []).includes("accessory")) continue;
    const k = (r.product_type ?? [])[0] ?? "any";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  let n = 0;
  for (const [k, g] of groups) {
    if (g.length < 4) continue;
    const med = median(g.map((r) => r.price as number));
    for (const r of g) if (r.price < 0.2 * med) {
      r.price_flag = `price outlier: $${r.price} is under 20% of the median $${Math.round(med * 100) / 100} for comparable ${k === "any" ? "" : k + " "}rows in this result; verify on the store page before trusting it`;
      n++;
    }
  }
  return n;
}

/** Attach flags and return the sort tier: 0 usable, 1 not checked yet, 2 suspect price, 3 not usable. */
export function flagRow(r: Row): number {
  const f = rowFlags(r);
  r.agent_usable = f.agent_usable; r.store_status = f.store_status; r.flags = f.flags;
  return f.agent_usable === false ? 3 : r.price_flag ? 2 : f.agent_usable === null ? 1 : 0;
}

/** One line per row for text surfaces (MCP): the warning comes first so a reader can't miss it. */
export function flagPrefix(r: Row): string {
  if (r.agent_usable === false) return `[DO NOT USE: ${r.store_status}] `;
  if (r.price_flag) return "[CHECK PRICE: outlier] ";
  if (Array.isArray(r.flags) && r.flags.some((x: string) => x.startsWith("no-add-to-cart"))) return "[NO ADD-TO-CART seen] ";
  return "";
}
