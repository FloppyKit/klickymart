"""Single source of truth for NIP-XX kind numbers and tag vocabulary. Kinds are provisional."""
KIND_SITE = 31420      # addressable site record, d = canonical domain
KIND_NEED = 420
KIND_FULFILL = 421
KIND_ACCEPT = 422
KIND_OFFER = 31421     # addressable product offer, d = <domain>:<gtin|mpn|sku>:<id>; collision-checked 2026-10-30 (KIND-31421-CHECK.md)
NS = "nip-xx"          # NIP-32 label namespace
LICENSE = "CC0-1.0"
TOP_CATEGORY = "shopping"
TOS_VALUES = {"ok", "bans-automation", "unknown"}
STATUS_VALUES = {"crawled", "blocked-tos", "agents-not-welcome", "error"}
# anw types: affirmative refusals (status agents-not-welcome) vs failures (status error)
ANW_REFUSAL = {"robots-disallow", "robots-403", "robots-429", "robots-block-page", "http-403", "http-429", "http-503", "block-page"}
ANW_FAILURE = {"robots-unreachable", "home-unreachable"}
ERR_CAUSES = {"dns", "timeout", "tls", "connect", "5xx", "4xx", "redirect-loop", "decode", "unknown"}
BTC_PRIV = {"noacct", "selfhosted", "ecash", "sp", "ark", "nokyc"}

# internal record code -> readable tag value (records keep short codes; tags emit these)
PAY_TAG = {
    "card": "card", "apay": "apple-pay", "gpay": "google-pay", "spay": "shop-pay",
    "pp": "paypal", "venmo": "venmo", "cashapp": "cashapp", "zelle": "zelle",
    "ach": "ach", "check": "check", "cod": "cod", "gift": "gift-card", "ebt": "ebt", "hsa": "hsa-fsa",
    "bnpl": "bnpl",
    "btc": "btc-onchain", "ln": "lightning", "lnurl": "lnurl", "bolt12": "bolt12",
    "sp": "silent-payments", "ark": "ark", "cashu": "cashu", "fedi": "fedimint", "liq": "liquid",
    "usdc": "usdc", "usdt": "usdt", "eth": "ethereum", "xmr": "monero", "ltc": "litecoin",
    "crypto": "crypto",
}

def pay_tag(code):
    """Readable tag value for an internal payment code. bnpl:<x> keeps its suffix; unknown -> other:<code>."""
    if code in PAY_TAG: return PAY_TAG[code]
    if code.startswith("bnpl:"): return code
    if code.startswith("oth:"): return "other:" + code[4:]
    return "other:" + code
