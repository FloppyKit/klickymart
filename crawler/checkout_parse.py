"""Pure parsing/merge logic for the guest checkout probe (no network)."""
import re

# (method code, regex) for payment screen text; codes match the rubric/extract.py
METHOD_RX = [
    ("card", r"\bcard number\b|\b(credit|debit) cards?\b|\bvisa\b|\bmastercard\b|\bamex\b|\bamerican express\b"),
    ("pp", r"\bpaypal\b"), ("apay", r"\bapple pay\b"), ("gpay", r"\bgoogle pay\b"), ("spay", r"\bshop pay\b"),
    ("ln", r"\blightning\b"), ("btc", r"\bbitcoin\b|\bbtc\b|\bon-?chain\b"),
    ("cashu", r"\bcashu\b|\becash\b"), ("fedi", r"\bfedimint\b"), ("liq", r"\bliquid\b"),
    ("usdt", r"\busdt\b|\btether\b"), ("usdc", r"\busdc\b"), ("eth", r"\bethereum\b"),
    ("xmr", r"\bmonero\b|\bxmr\b"), ("ltc", r"\blitecoin\b"), ("crypto", r"\bcrypto(currency|currencies)?\b"),
]
BTC_CODES = {"btc", "ln", "cashu", "fedi", "liq", "lnurl", "bolt12", "sp", "ark"}
# processor: (regex over html/urls/text, custodial?)
PROCESSORS = {
    "btcpay": (r"btcpay", False), "opennode": (r"opennode", True), "strike": (r"\bstrike\.me\b|strike checkout", True),
    "bitpay": (r"bitpay", True), "coinbase": (r"commerce\.coinbase|coinbase commerce", True),
    "nowpayments": (r"nowpayments", True), "coingate": (r"coingate", True), "zaprite": (r"zaprite", True),
    "ibexpay": (r"ibexpay|ibex ?mercado", True), "speed": (r"tryspeed|speed\.app", True), "blink": (r"blink\.sv", True),
    "lnbits": (r"lnbits", False), "stripe": (r"js\.stripe\.com|stripe", True),
}
PRIV_RX = {"ecash": r"\bcashu\b|\becash\b|\bfedimint\b", "sp": r"\bsilent payments?\b", "ark": r"\bark (protocol|payment)"}
PAY_SCREEN_RX = re.compile(r"(?i)\b(payment method|payment options|pay with|select (a )?payment|how would you like to pay|payment)\b")
CONTACT_FIELDS = re.compile(r"(?i)email|e-mail|phone")
ADDRESS_FIELDS = re.compile(r"(?i)address|postal|zip|street|city")

def find_methods(text):
    """[{c, ev}] from visible payment screen text; ev is the matching line."""
    out, seen = [], set()
    for line in (text or "").splitlines():
        s = line.strip()
        if not s or len(s) > 300: continue
        for c, rx in METHOD_RX:
            if c not in seen and re.search(rx, s, re.I):
                seen.add(c); out.append({"c": c, "ev": s[:200]})
    codes = {m["c"] for m in out}
    if codes & {"btc", "usdt", "usdc", "eth", "xmr", "ltc"}:
        out = [m for m in out if m["c"] != "crypto"]
    return out

def find_processors(blob, merchant_domain=None, hosts=()):
    """[{p, custodial, selfhosted, ev}] from html/script/iframe URLs. btcpay is self-hosted when its host is under the merchant domain."""
    out = []
    low = (blob or "").lower()
    for p, (rx, cust) in PROCESSORS.items():
        m = re.search(rx, low)
        if not m: continue
        e = {"p": p, "custodial": cust, "selfhosted": False, "ev": low[max(0, m.start()-40):m.end()+40]}
        if p in ("btcpay", "lnbits") and merchant_domain:
            e["selfhosted"] = any(h == merchant_domain or h.endswith("." + merchant_domain) for h in hosts if re.search(rx, h) or "pay" in h)
        out.append(e)
    return out

def classify_gate(field_names):
    """What personal-data form blocks progress: after_contact_form / after_address / None."""
    names = " ".join(field_names or [])
    if ADDRESS_FIELDS.search(names): return "after_address"
    if CONTACT_FIELDS.search(names): return "after_contact_form"
    return None

def btc_offered(methods, processors, step_reached):
    codes = {m["c"] for m in methods}
    if codes & BTC_CODES or any(p["p"] in ("btcpay", "opennode", "strike", "bitpay", "zaprite", "ibexpay", "speed", "blink", "lnbits") for p in processors):
        return "yes"
    if step_reached == "payment_methods": return "no"
    return "unknown"

def privacy_hints(methods, processors, text, guest_reached):
    h = set()
    if guest_reached: h.add("noacct")
    if any(p["selfhosted"] for p in processors): h.add("selfhosted")
    codes = {m["c"] for m in methods}
    if codes & {"cashu", "fedi"}: h.add("ecash")
    for k, rx in PRIV_RX.items():
        if re.search(rx, text or "", re.I): h.add(k)
    return sorted(h)

def grade(probe):
    """Bitcoin grade 0-4 from one probe result, or None when inconclusive (rubric grades)."""
    if probe.get("btc_offered") == "no": return 0
    if probe.get("btc_offered") != "yes": return None
    priv = set(probe.get("privacy") or [])
    procs = probe.get("processors") or []
    if "noacct" in priv and "selfhosted" in priv:
        return 4 if priv & {"ecash", "sp", "ark"} else 3
    if "noacct" in priv and any(p["custodial"] for p in procs if p["p"] != "stripe"):
        return 2
    return None   # bitcoin seen but custody/account unverified: leave for hand grading

def phone_required(probe):
    """True when the guest checkout form required a phone number before payment; False when the probe got past the
    contact step without one; None when the probe never reached a checkout form (inconclusive)."""
    if (probe or {}).get("pm_visible") == "after_phone": return True
    if (probe or {}).get("step_reached") in ("payment_methods", "after_contact", "after_address"): return False
    return None

def merge(record, probe):
    """Return a new record updated from a probe result. Never downgrades a hand-set grade; only conclusive probes change btc."""
    r = dict(record)
    if not probe or probe.get("d") != r.get("d"): return r
    g = grade(probe)
    if probe.get("btc_offered") == "yes": r["btc_any"] = True
    if g is not None and (r.get("btc_src") != "hand" or r.get("btc") is None):
        r["btc"] = g; r["btc_src"] = "checkout-probe"
    priv = sorted(set(r.get("btc_priv") or []) | ({"noacct", "selfhosted", "ecash", "sp", "ark"} & set(probe.get("privacy") or [])
                  if probe.get("btc_offered") == "yes" else set()))
    if priv: r["btc_priv"] = priv
    seen = [m["c"] for m in probe.get("methods") or []]
    if probe.get("step_reached") == "payment_methods" and seen:
        r["pay_checkout"] = seen
    r["checkout_probe"] = {k: probe.get(k) for k in ("step_reached", "pm_visible", "btc_offered", "ts", "shot")}
    pr = phone_required(probe)
    if pr is not None: r["checkout_probe"]["phone_required"] = pr
    return r

CAND_CODES = {"btc", "ln", "cashu", "fedi", "liq", "crypto", "usdt", "usdc", "eth", "xmr", "ltc", "lnurl", "bolt12", "sp", "ark"}
def is_candidate(record, btc_native=()):
    if record.get("d") in btc_native: return True
    if record.get("btc_any"): return True
    codes = set(record.get("pay") or []) | set(record.get("pay_unscoped") or []) | set(record.get("pay_online") or [])
    codes |= {q.get("c") for q in record.get("pay_q") or []}
    return bool(codes & CAND_CODES)
