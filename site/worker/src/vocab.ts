/** The one vocabulary: every code/category list used by /q, /alternatives, /offers, MCP schemas, llms.txt and openapi.json comes from here. */
import { PAY_CODES, CAT_CODES, STATUS_VALUES, PAY_GROUPS } from "./codes";
import { V1_CATEGORIES } from "./category";

export const COARSE_CATEGORIES = ["electronics", "gift-cards", "groceries", "apparel", "hardware", "books", "travel", "crypto-hardware", "other"] as const;
export const SUBCATEGORIES = ["audio", "computers", "phones", "tv-video", "cameras", "gaming", "wearables", "smart-home", "appliances", "networking", "accessories", "gift-cards", "wholesale", "handbags"] as const;
export { PAY_CODES, CAT_CODES, STATUS_VALUES, V1_CATEGORIES };
export const PAY_GROUP_NAMES = Object.keys(PAY_GROUPS) as string[];
/** Friendly names agents use -> canonical pay code. */
export const PAY_ALIASES: Record<string, string> = {
  "btc-onchain": "btc", onchain: "btc", "on-chain": "btc", bitcoin_onchain: "btc",
  lightning: "ln", "btc-lightning": "ln",
  "shop-pay": "spay", shoppay: "spay", "apple-pay": "apay", applepay: "apay", "google-pay": "gpay", googlepay: "gpay",
  paypal: "pp", "gift-card": "gift", giftcard: "gift", "credit-card": "card", "debit-card": "card", "cash-app": "cashapp", ecash: "cashu", "stripe-link": "link", "link-by-stripe": "link",
};
/** /alternatives pay filter names (what each expands to). */
export const ALT_PAY_FILTERS: Record<string, string[]> = { lightning: ["ln", "lnurl", "bolt12"], btc: ["btc"], onchain: ["btc"], "btc-onchain": ["btc"], bitcoin: ["btc", "ln", "lnurl", "bolt12"], cashu: ["cashu"], ecash: ["cashu"] };
/** What each first_blocker kind means (rendered in llms.txt and /vocab.json). */
export const BLOCKER_DESCRIPTIONS: Record<string, string> = {
  none: "the probe reached the payment-method screen; nothing stopped it",
  "login-wall": "checkout requires signing in or creating an account (guest checkout not offered)",
  "bot-wall": "a challenge or captcha page appeared; KlickyBot never tries to get past it",
  "http-refusal": "the site answered 403, 429 or 503 to our honest user agent",
  "network-error": "connection resets or timeouts on every retry; not a refusal, so co stays null and a retry is scheduled",
  "no-product-link": "the probe could not find a link to any product page from the public pages it may read",
  "no-add-to-cart": "a product page loaded but no add-to-cart control was found or it did nothing",
  "form-gate": "the checkout form was reached but a required field (needs: email, phone, address...) stopped the probe; it never types real personal data",
  "no-checkout-button": "the item was added to the cart but the cart page had no checkout button or link the probe could find",
  "probe-error": "the probe itself failed (browser crash, script error or page timeout) before reaching a verdict; the store is not at fault",
  robots: "robots.txt disallows the next page the probe needed (cart or checkout), so it stopped there",
  unclassified: "the probe stopped for a reason not yet classified; see the record's why/evidence",
};
export const BLOCKER_KINDS = ["none", "login-wall", "bot-wall", "http-refusal", "network-error", "no-product-link", "no-add-to-cart", "form-gate", "no-checkout-button", "probe-error", "robots", "unclassified"] as const;
/** Categories accepted by /q `category`: the v1 vertical plus coarse product categories. */
export const Q_CATEGORIES = [...V1_CATEGORIES, ...COARSE_CATEGORIES] as string[];

/** Canonicalize one pay code: aliases -> canonical; groups (bitcoin/lightning/ecash) kept as group names. */
export function canonPay(c: string): string { const k = c.trim().toLowerCase(); return PAY_ALIASES[k] ?? k; }
export function isPayCode(c: string): boolean {
  const base = c.split(":")[0]!;
  return (PAY_CODES as readonly string[]).includes(base) || base === "bnpl" || base === "oth";
}
export function vocabulary() {
  return { q_bool_filters: [...Q_BOOL_FILTERS], btc_processors: [...BTC_PROCESSORS], pay_codes: [...PAY_CODES], pay_aliases: PAY_ALIASES, pay_groups: PAY_GROUP_NAMES, alternatives_pay: Object.keys(ALT_PAY_FILTERS),
    cat_codes: [...CAT_CODES], categories: [...COARSE_CATEGORIES], q_categories: Q_CATEGORIES, subs: [...SUBCATEGORIES], status: [...STATUS_VALUES], first_blocker_kinds: [...BLOCKER_KINDS], first_blocker_descriptions: BLOCKER_DESCRIPTIONS };
}

/** /q boolean filters (0|1). Kept here so llms.txt, openapi and MCP list the same set. */
export const Q_BOOL_FILTERS = ["guest", "reachable", "ship_pre", "ships_us", "btc_indirect"] as const;
/** Third-party bitcoin processors: a store using one takes BTC only indirectly (btc_indirect), not natively. */
export const BTC_PROCESSORS = ["bitpay", "coinbase-commerce", "confirmo", "opennode", "nowpayments", "coinpayments", "cryptomus", "triple-a", "coingate", "strike", "speed", "zaprite-hosted", "bitrefill-giftcard"] as const;
