"""Pure tag generation for kind 31420 site records (no keys, no network)."""
import re
from kinds import NS, LICENSE, TOP_CATEGORY, TOS_VALUES, STATUS_VALUES, BTC_PRIV, ERR_CAUSES, pay_tag

_LABEL = re.compile(r"^[a-z0-9-]{1,63}$")

def validate_domain(d):
    """Raise ValueError unless d is canonical: lowercase, ASCII/punycode, no scheme/path/port, no leading www."""
    if not isinstance(d, str) or not d: raise ValueError("empty domain")
    if d != d.strip().lower(): raise ValueError(f"not lowercase/trimmed: {d!r}")
    if "/" in d or ":" in d or "@" in d: raise ValueError(f"scheme/path/port in domain: {d!r}")
    if d.startswith("www."): raise ValueError(f"leading www.: {d!r}")
    try: d.encode("ascii")
    except UnicodeEncodeError: raise ValueError(f"not punycode: {d!r}")
    parts = d.split(".")
    if len(parts) < 2 or not all(_LABEL.match(p) and not p.startswith("-") and not p.endswith("-") for p in parts):
        raise ValueError(f"bad domain labels: {d!r}")
    return d

def tos_value(v):
    return v if v in TOS_VALUES and v != "unknown" else "unknown"

def _l(k, v=None): return ["l", k if v is None else f"{k}:{v}", NS]

def _ua_product(ua):
    if not ua: return None
    m = re.match(r"^(\S+)(?:.*?\+(https?://[^;\s)]+))?", ua)
    return [m.group(1)] + ([m.group(2)] if m.group(2) else [])

def tags_for(r):
    d = validate_domain(r.get("d"))
    v = r.get("v")
    if not v: raise ValueError(f"{d}: record has no v")
    status = r.get("status") or "crawled"
    if status not in STATUS_VALUES: raise ValueError(f"{d}: bad status {status!r}")
    if r.get("ts") is None: raise ValueError(f"{d}: record has no ts")
    t = [["d", d], ["r", d], ["L", NS], ["t", TOP_CATEGORY]]
    for c in r.get("cat") or []: t.append(["t", c])
    if r.get("name"): t.append(["name", r["name"]])
    t += [_l("status", status), _l("tos", tos_value(r.get("tos"))),
          ["crawled_at", str(int(r["ts"]))], ["v", v], ["license", LICENSE]]
    vant = (r.get("vantage") or {}).get("ip")
    if vant: t.append(["vantage", vant])
    ua = _ua_product(r.get("ua"))
    if ua: t.append(["crawler"] + ua)
    if status == "blocked-tos":   # bare record: name, URL, status, ToS quote live in content
        return t
    seen = set()
    def add(tag):
        k = tuple(tag)
        if k not in seen: seen.add(k); t.append(tag)
    for f in ("ag", "co", "btc"):
        if r.get(f) is not None: add(_l(f, int(r[f])))
    if r.get("btc_any"): add(_l("btc_any"))
    for p in r.get("btc_priv") or []:
        if p not in BTC_PRIV: raise ValueError(f"{d}: bad btc_priv {p!r}")
        add(_l("btcpriv", p))
    if r.get("guest") is not None: add(_l("guest", "yes" if r["guest"] else "no"))
    if r.get("kyc"): add(_l("kyc", r["kyc"]))
    for p in r.get("pay") or []: add(_l("pay", pay_tag(p)))
    for scope in ("pay_online", "pay_instore", "pay_unscoped"):
        for p in r.get(scope) or []: add(_l(scope, pay_tag(p)))
    for p in r.get("pay_no") or []: add(_l("no", pay_tag(p)))
    for a in sorted({x["c"] for x in r.get("ar") or []}): add(_l("ar", a))
    for sc in r.get("sub") or []: add(_l("sub", sc))
    ap = r.get("agent_policy")
    if ap and ap.get("v"): add(_l("agentpolicy", ap["v"]))
    sh = r.get("ship") or {}
    if sh.get("pre_pay") is not None: add(_l("shippre", "yes" if sh["pre_pay"] else "no"))
    if sh.get("ships_us") is not None: add(_l("shipsus", "yes" if sh["ships_us"] else "no"))
    # v0.5 (GO-DATA-V2): checkout stage/blocker, free-shipping, agent-usable rails, policies, domain age
    cm = r.get("checkout_map") or {}
    if cm.get("stage"): add(_l("costage", cm["stage"]))
    if (cm.get("first_blocker") or {}).get("kind"): add(_l("block", cm["first_blocker"]["kind"]))
    if sh.get("free_min_usd") is not None: add(_l("freeship")); t.append(["freeship", str(sh["free_min_usd"]), "USD"])
    for a in r.get("agentpay") or []: add(_l("agentpay", a["rail"]))
    pol = r.get("policies") or {}
    if pol.get("return_days") is not None: add(_l("ret", int(pol["return_days"])))
    if pol.get("return_ship_payer"): add(_l("retship", pol["return_ship_payer"]))
    if pol.get("price_match"): add(_l("pm", pol["price_match"]))
    if pol.get("restocking_pct") is not None: add(_l("restock", "1" if pol["restocking_pct"] else "0"))
    tr = r.get("trust") or {}
    if tr.get("age_bucket"): add(_l("age", tr["age_bucket"]))
    if (r.get("ucp") or {}).get("present"): add(_l("ucp"))
    pr = (r.get("checkout_probe") or {}).get("phone_required")
    if pr is not None: add(_l("phonereq", "yes" if pr else "no"))
    # agent-native (2026-10-30): flag, claimed agent rails, agent API kind
    if r.get("agent_native"): add(_l("agent_native"))
    for rail in r.get("an_rails") or []:
        if not _LABEL.match(rail.replace("_", "-")): raise ValueError(f"{d}: bad an_rail {rail!r}")
        add(_l("anrail", rail))
    aa = r.get("agent_api") or {}
    if aa.get("kind"): add(_l("agentapi", aa["kind"]))
    anw = r.get("anw")
    if anw and anw.get("type"): add(_l("anw", anw["type"]))
    if anw and anw.get("cause") in ERR_CAUSES: add(_l("cause", anw["cause"]))
    return t

def tags_match_content(tags, record):
    """True if the tags are exactly what the record content implies (order-insensitive)."""
    return sorted(map(tuple, tags)) == sorted(map(tuple, tags_for(record)))
