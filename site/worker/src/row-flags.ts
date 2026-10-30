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

/** Checkout-map stages that prove add-to-cart worked (cart and beyond) or reached the payment-method step (paypage). */
const CONFIRMED_STAGES = new Set(["cart", "checkout", "shipform", "paypage", "payment"]);
/** Two-letter ccTLDs used as generic names (not a country signal). */
const GENERIC_CC = new Set(["co", "io", "ai", "tv", "me", "gg", "ly", "fm", "to", "sh", "so", "cc", "us"]);
/** Store looks non-US: its record says it does not ship to the US, or its domain is under a country TLD (e.g. .com.au, .ae). */
export function nonUsStore(domain: string, shipsUs: boolean | null | undefined): string | null {
  if (shipsUs === false) return "store's shipping policy says it does not ship to the US";
  if (shipsUs === true) return null;
  const tld = String(domain).toLowerCase().split(".").pop() ?? "";
  return tld.length === 2 && !GENERIC_CC.has(tld) ? `.${tld} store (country domain)` : null;
}

export function rowFlags(r: Row, opts: { usZip?: boolean } = {}): { agent_usable: boolean | null; store_status: string; flags: string[]; non_us?: boolean } {
  const st = r.store ?? {};
  const flags: string[] = [];
  let usable: boolean | null;
  let status: string;
  if (st.indexed === false || !st.verdict) { status = "not-indexed"; usable = null; flags.push("store not checked yet: robots, terms and checkout facts unknown"); }
  else {
    status = String(st.verdict);
    if (NOT_USABLE[status]) { usable = false; flags.push(`${status}: ${NOT_USABLE[status]}`); }
    else {
      // usable only when our guest probe confirmed add-to-cart or reached the payment-method step
      const stage = st.checkout_stage as string | null | undefined;
      usable = (stage && CONFIRMED_STAGES.has(stage)) || (typeof (st.checkout_depth ?? st.co) === "number" && (st.checkout_depth ?? st.co) >= 2) ? true : null;
      if (usable === null) flags.push("unconfirmed: our guest probe has not confirmed add-to-cart or reached the payment step at this store");
    }
    const fb = st.first_blocker as string | null | undefined;
    if (usable !== false && fb && BLOCKER_FLAGS[fb]) { flags.push(`${fb}: ${BLOCKER_FLAGS[fb]}`); if (fb === "login-wall" || fb === "no-add-to-cart") usable = false; }
  }
  let nonUs = false;
  if (opts.usZip) { const why = nonUsStore(String(st.domain ?? r.domain ?? ""), st.ships_us); if (why) { nonUs = true; flags.push(`may not ship to US: ${why}`); } }
  if (r.brand_match === "lookalike") flags.push("brand look-alike spelling: likely not genuine");
  if (r.price_flag) flags.push(String(r.price_flag));
  return { agent_usable: usable, store_status: status, flags, ...(nonUs ? { non_us: true } : {}) };
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
export function flagRow(r: Row, opts: { usZip?: boolean } = {}): number {
  const f = rowFlags(r, opts);
  r.agent_usable = f.agent_usable; r.store_status = f.store_status; r.flags = f.flags;
  if (f.non_us) r.may_not_ship_to_us = true;
  return f.agent_usable === false ? 3 : r.price_flag || f.non_us ? 2 : f.agent_usable === null ? 1 : 0;
}

/** One line per row for text surfaces (MCP): the warning comes first so a reader can't miss it. */
export function flagPrefix(r: Row): string {
  if (r.agent_usable === false && Array.isArray(r.flags) && r.flags.some((x: string) => x.startsWith("no-add-to-cart"))) return "[DO NOT USE: NO ADD-TO-CART seen] ";
  if (r.agent_usable === false) return `[DO NOT USE: ${r.store_status}] `;
  if (r.price_flag) return "[CHECK PRICE: outlier] ";
  if (r.may_not_ship_to_us) return "[MAY NOT SHIP TO US] ";
  if (Array.isArray(r.flags) && r.flags.some((x: string) => x.startsWith("no-add-to-cart"))) return "[NO ADD-TO-CART seen] ";
  return "";
}
