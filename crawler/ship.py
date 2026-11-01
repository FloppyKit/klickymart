"""Round-1 item 8: shipping cost/threshold from public structured data only (robots first, honest UA, <=8 requests/store).
Sources, in order: schema.org OfferShippingDetails / shippingDetails in product-page JSON-LD; the store's own shipping page
text ("free shipping on orders over $X", "shipping is always free", flat "$X standard shipping"). No cart endpoints."""
import json, re, sys, time, datetime, urllib.robotparser, concurrent.futures as cf
from urllib.parse import urljoin
from offers import Site
from ua import UA_TOKEN
iso = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
SHIP_PATHS = ["/policies/shipping-policy", "/pages/shipping", "/shipping", "/help/shipping", "/shipping-policy", "/pages/shipping-policy", "/customer-service/shipping"]
FREE_OVER = re.compile(r"(?i)free (standard |ground |economy )?shipping (on|for) (all )?(us |u\.s\. |domestic )?orders (of |over |above |\$)\s*\$?\s?(\d{1,4}(?:\.\d\d)?)\+?")
FREE_OVER2 = re.compile(r"(?i)orders (over|of|above) \$(\d{1,4}(?:\.\d\d)?)\+? (ship|qualify for|receive|get) free")
FREE_ALL = re.compile(r"(?i)(shipping is always free|free shipping on (all|every) (us |u\.s\. )?orders|always free shipping|free standard shipping on all orders)")
# #31 (audit 2026-10-31): Shopify themes put the cart-drawer free-shipping bar's threshold in their settings JSON, and
# announcement bars on the home page often state it. Only used when no shipping page gave a policy.
THEME_FREE = re.compile(r'(?i)"free_shipping_(?:threshold|minimum|min|goal|amount)"\s*:\s*"?(\d{1,6}(?:\.\d{1,2})?)"?')
def free_min_from_home(h, t):
    m = THEME_FREE.search(h or "")
    if m:
        v = float(m.group(1)); v = v / 100 if v >= 1000 and v == int(v) else v  # minor units in most themes
        if 0 < v <= 1000: return v, m.group(0)[:120], "theme-settings-json"
    m = FREE_OVER.search(t) or FREE_OVER2.search(t)
    if m: return float(m.groups()[-1]) if m.re is FREE_OVER else float(m.group(2)), m.group(0)[:160], "home-page-text"
    return None
FLAT = re.compile(r"(?i)(standard|ground|flat[- ]rate) shipping[^.$]{0,40}\$(\d{1,3}\.\d\d)")
def text_of(h): return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", h))).replace("&amp;", "&").replace("&#36;", "$")
def ld_blocks(h):
    for m in re.finditer(r'(?is)<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h):
        try: yield json.loads(m.group(1).strip())
        except Exception: pass
def walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
def ship_from_ld(h):
    out = []
    for b in ld_blocks(h):
        for o in walk(b):
            if o.get("@type") in ("OfferShippingDetails",) or "shippingRate" in o:
                rate = o.get("shippingRate") or {}
                if isinstance(rate, list): rate = rate[0] if rate else {}
                dest = o.get("shippingDestination") or {}
                if isinstance(dest, list): dest = dest[0] if dest else {}
                v = rate.get("value") if isinstance(rate, dict) else None
                try: v = float(v) if v is not None else None
                except Exception: v = None
                out.append({"rate": v, "cur": rate.get("currency") if isinstance(rate, dict) else None,
                            "country": dest.get("addressCountry") if isinstance(dest, dict) else None,
                            "free_threshold": (o.get("freeShippingThreshold") or {}).get("price") if isinstance(o.get("freeShippingThreshold"), dict) else None})
    return out
def run(d, base, urls):
    s = Site(d, base); res = {"domain": d, "checked_at": iso(), "ld": [], "policy": None}
    st, rb = s.get(base.rstrip("/") + "/robots.txt")
    if st not in (200, 404): res["skip"] = f"robots {st}"; return res
    s.rp = urllib.robotparser.RobotFileParser(); s.rp.parse(rb.splitlines() if st == 200 else [])
    for u in urls[:3]:
        st, h = s.get(u)
        if st == 200:
            for x in ship_from_ld(h): x["src"] = u; x["method"] = "jsonld-shippingDetails"; res["ld"].append(x)
    for p in SHIP_PATHS:
        if s.n >= 8: break
        u = urljoin(base, p); st, h = s.get(u)
        if st != 200 or not h: continue
        t = text_of(h)
        m = FREE_ALL.search(t)
        if m: res["policy"] = {"free_min_usd": 0, "q": m.group(0), "src": u, "method": "shipping-page-text"}; break
        m = FREE_OVER.search(t) or FREE_OVER2.search(t)
        if m:
            amt = float(m.groups()[-1]) if FREE_OVER.search(t) and m.re is FREE_OVER else float(m.group(2))
            i = m.start(); res["policy"] = {"free_min_usd": amt, "q": t[max(0, i - 20): m.end() + 40].strip(), "src": u, "method": "shipping-page-text"}
            f = FLAT.search(t)
            if f: res["policy"]["flat_usd"] = float(f.group(2)); res["policy"]["flat_q"] = f.group(0)
            break
        f = FLAT.search(t)
        if f: res["policy"] = {"flat_usd": float(f.group(2)), "q": f.group(0), "src": u, "method": "shipping-page-text"}; break
    if res["policy"] is None and s.n < 9:
        st, h = s.get(base)
        if st == 200 and h:
            r = free_min_from_home(h, text_of(h))
            if r: res["policy"] = {"free_min_usd": r[0], "q": r[1], "src": base, "method": r[2]}
    res["requests"] = s.log
    return res
if __name__ == "__main__":
    offers = [json.loads(l) for l in open("out/offers.jsonl")]
    bases = {}
    for l in open("out/records.v4.jsonl"):
        r = json.loads(l)
        if r.get("status") == "crawled" and r.get("tos") != "bans-automation": bases[r["d"]] = r.get("base") or f"https://{r['d']}/"
    by = {}
    for o in offers:
        if o["method"] == "jsonld" and o.get("url"): by.setdefault(o["domain"], []).append(o["url"])
    doms = sorted({o["domain"] for o in offers} | set(sys.argv[1:]))
    with cf.ThreadPoolExecutor(8) as ex, open("out/shipping.jsonl", "w") as f:
        for res in ex.map(lambda d: run(d, bases.get(d, f"https://{d}/"), list(dict.fromkeys(by.get(d, [])))), [d for d in doms if d in bases]):
            f.write(json.dumps(res) + "\n"); print(res["domain"], len(res["ld"]), res.get("policy") and {k: res["policy"].get(k) for k in ("free_min_usd", "flat_usd")}, res.get("skip"), flush=True)
