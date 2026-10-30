/** The one vocabulary: every code/category list used by /q, /alternatives, /offers, MCP schemas, llms.txt and openapi.json comes from here. */
import { PAY_CODES, CAT_CODES, STATUS_VALUES, PAY_GROUPS } from "./codes";
import { V1_CATEGORIES } from "./category";

export const COARSE_CATEGORIES = ["electronics", "gift-cards", "groceries", "apparel", "hardware", "books", "travel", "crypto-hardware", "other"] as const;
export const SUBCATEGORIES = ["audio", "computers", "phones", "tv-video", "cameras", "gaming", "wearables", "smart-home", "appliances", "networking", "accessories", "gift-cards", "wholesale"] as const;
export { PAY_CODES, CAT_CODES, STATUS_VALUES, V1_CATEGORIES };
export const PAY_GROUP_NAMES = Object.keys(PAY_GROUPS) as string[];
/** Friendly names agents use -> canonical pay code. */
export const PAY_ALIASES: Record<string, string> = {
  "btc-onchain": "btc", onchain: "btc", "on-chain": "btc", bitcoin_onchain: "btc",
  lightning: "ln", "btc-lightning": "ln",
  "shop-pay": "spay", shoppay: "spay", "apple-pay": "apay", applepay: "apay", "google-pay": "gpay", googlepay: "gpay",
  paypal: "pp", "gift-card": "gift", giftcard: "gift", "credit-card": "card", "debit-card": "card", "cash-app": "cashapp", ecash: "cashu",
};
/** /alternatives pay filter names (what each expands to). */
export const ALT_PAY_FILTERS: Record<string, string[]> = { lightning: ["ln", "lnurl", "bolt12"], btc: ["btc"], onchain: ["btc"], "btc-onchain": ["btc"], bitcoin: ["btc", "ln", "lnurl", "bolt12"], cashu: ["cashu"], ecash: ["cashu"] };
export const BLOCKER_KINDS = ["none", "login-wall", "bot-wall", "http-refusal", "network-error", "no-product-link", "no-add-to-cart", "form-gate", "robots", "unclassified"] as const;
/** Categories accepted by /q `category`: the v1 vertical plus coarse product categories. */
export const Q_CATEGORIES = [...V1_CATEGORIES, ...COARSE_CATEGORIES] as string[];

/** Canonicalize one pay code: aliases -> canonical; groups (bitcoin/lightning/ecash) kept as group names. */
export function canonPay(c: string): string { const k = c.trim().toLowerCase(); return PAY_ALIASES[k] ?? k; }
export function isPayCode(c: string): boolean {
  const base = c.split(":")[0]!;
  return (PAY_CODES as readonly string[]).includes(base) || base === "bnpl" || base === "oth";
}
export function vocabulary() {
  return { pay_codes: [...PAY_CODES], pay_aliases: PAY_ALIASES, pay_groups: PAY_GROUP_NAMES, alternatives_pay: Object.keys(ALT_PAY_FILTERS),
    cat_codes: [...CAT_CODES], categories: [...COARSE_CATEGORIES], q_categories: Q_CATEGORIES, subs: [...SUBCATEGORIES], status: [...STATUS_VALUES], first_blocker_kinds: [...BLOCKER_KINDS] };
}
