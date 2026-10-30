/** Bit assignments — append-only; published at /docs/api#codes */

export const PAY_CODES = [
  "card", "apay", "gpay", "spay", "pp", "venmo", "cashapp", "zelle", "ach", "check",
  "cod", "gift", "bnpl", "ebt", "btc", "ln", "lnurl", "bolt12", "sp", "ark", "cashu",
  "fedi", "liq", "usdc", "usdt", "eth", "xmr", "ltc", "crypto", "oth", "hsa",
] as const;
export type PayCode = (typeof PAY_CODES)[number];

export const AR_CODES = [
  "rb_ai", "rb_ck", "cf", "ak", "px", "cap", "cap!", "403", "429", "tarpit", "hl", "js", "net", "tos", "acct", "geo", "block",
] as const;
export type ArCode = (typeof AR_CODES)[number];

export const CAT_CODES = [
  "gen", "elec", "groc", "appr", "home", "beau", "food", "trav", "tix", "auto", "pet", "toy", "book", "sw", "mkt", "oth",
  "btcnative", "gift", "sport", "office", "craft", "jewel",
] as const;
export type CatCode = (typeof CAT_CODES)[number];

export const STATUS_VALUES = ["crawled", "blocked-tos", "agents-not-welcome", "error"] as const;
export type StatusValue = (typeof STATUS_VALUES)[number];

export const STATUS_CODE: Record<StatusValue, number> = {
  crawled: 0,
  "blocked-tos": 1,
  "agents-not-welcome": 2,
  error: 3,
};

export const PAY_BIT: Record<string, number> = {};
PAY_CODES.forEach((c, i) => { PAY_BIT[c] = 1 << i; });

export const AR_BIT: Record<string, number> = {};
AR_CODES.forEach((c, i) => { AR_BIT[c] = 1 << i; });

export const CAT_BIT: Record<string, number> = {};
CAT_CODES.forEach((c, i) => { CAT_BIT[c] = 1 << i; });

const BTC_GROUP = ["btc", "ln", "lnurl", "bolt12", "sp", "ark", "cashu", "fedi", "liq"] as const;
const LN_GROUP = ["ln", "lnurl", "bolt12"] as const;
const ECASH_GROUP = ["cashu", "fedi"] as const;

export const PAY_GROUPS: Record<string, number> = {
  bitcoin: 0,
  lightning: 0,
  ecash: 0,
};
for (const c of BTC_GROUP) PAY_GROUPS.bitcoin |= PAY_BIT[c] ?? 0;
for (const c of LN_GROUP) PAY_GROUPS.lightning |= PAY_BIT[c] ?? 0;
for (const c of ECASH_GROUP) PAY_GROUPS.ecash |= PAY_BIT[c] ?? 0;

export function payCodeToBit(code: string): number {
  const base = code.split(":")[0]!;
  if (base in PAY_BIT) return PAY_BIT[base]!;
  if (base.startsWith("bnpl")) return PAY_BIT.bnpl!;
  if (base.startsWith("oth")) return PAY_BIT.oth!;
  return 0;
}

export function arCodeToBit(code: string): number {
  return AR_BIT[code] ?? 0;
}

export function catCodeToBit(code: string): number {
  return CAT_BIT[code] ?? CAT_BIT.oth!;
}

export function maskToPayCodes(mask: number): string[] {
  const out: string[] = [];
  for (const c of PAY_CODES) {
    if (mask & PAY_BIT[c]!) out.push(c);
  }
  return out;
}

export function maskToArCodes(mask: number): string[] {
  const out: string[] = [];
  for (const c of AR_CODES) {
    if (mask & AR_BIT[c]!) out.push(c);
  }
  return out;
}

export const PAY_LABELS: Record<string, string> = {
  card: "Card", apay: "Apple Pay", gpay: "Google Pay", spay: "Shop Pay", pp: "PayPal",
  venmo: "Venmo", cashapp: "Cash App", zelle: "Zelle", ach: "ACH", check: "Check",
  cod: "Cash on delivery", gift: "Gift card", bnpl: "Buy now pay later", ebt: "EBT",
  btc: "Bitcoin on-chain", ln: "Lightning", lnurl: "LNURL", bolt12: "BOLT12", sp: "Silent payments",
  ark: "Ark", cashu: "Cashu", fedi: "Fedimint", liq: "Liquid", usdc: "USDC", usdt: "USDT",
  eth: "Ethereum", xmr: "Monero", ltc: "Litecoin", crypto: "Crypto", oth: "Other",
  hsa: "HSA / FSA",
};

export const AR_LABELS: Record<string, string> = {
  rb_ai: "Robots blocks AI agents", rb_ck: "Robots blocks checkout", cf: "Cloudflare challenge",
  ak: "Akamai block", px: "PerimeterX", cap: "Captcha present", "cap!": "Captcha served",
  "403": "HTTP 403", tarpit: "Timeout/tarpit", hl: "Headless blocked", js: "JS-only content",
  tos: "Terms ban automation", acct: "Account required", geo: "Region block",
  "429": "HTTP 429", net: "Network / fetch failure", block: "Explicit block page",
};

export const BTC_GRADE_MEANINGS = [
  "No bitcoin",
  "Via a custodial or KYC converter",
  "Custodial processor, no buyer account",
  "Self-hosted, no buyer account",
  "Grade 3 plus privacy features",
] as const;
