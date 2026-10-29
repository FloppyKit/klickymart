/** Map Nostr `l pay:*` readable names (data/TAGS.md) to internal crawl record pay codes. */

export const TAG_PAY_TO_INTERNAL: Record<string, string> = {
  card: "card",
  "apple-pay": "apay",
  "google-pay": "gpay",
  "shop-pay": "spay",
  paypal: "pp",
  venmo: "venmo",
  cashapp: "cashapp",
  zelle: "zelle",
  ach: "ach",
  check: "check",
  cod: "cod",
  "gift-card": "gift",
  bnpl: "bnpl",
  ebt: "ebt",
  "btc-onchain": "btc",
  lightning: "ln",
  lnurl: "lnurl",
  bolt12: "bolt12",
  "silent-payments": "sp",
  ark: "ark",
  cashu: "cashu",
  fedimint: "fedi",
  liquid: "liq",
  usdc: "usdc",
  usdt: "usdt",
  ethereum: "eth",
  monero: "xmr",
  litecoin: "ltc",
  crypto: "crypto",
  "hsa-fsa": "hsa",
};

export function tagPayToInternal(tagValue: string): string {
  const v = tagValue.trim().toLowerCase();
  if (v.startsWith("bnpl:") || v.startsWith("other:")) return v.replace("other:", "oth:");
  if (v in TAG_PAY_TO_INTERNAL) return TAG_PAY_TO_INTERNAL[v]!;
  return v;
}

export function internalPayToTag(code: string): string {
  for (const [tag, internal] of Object.entries(TAG_PAY_TO_INTERNAL)) {
    if (internal === code.split(":")[0]) return tag;
  }
  return code;
}
