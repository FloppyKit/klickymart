"""GO D11: seed discovery from BTC Map (ODbL, (c) OpenStreetMap contributors, via api.btcmap.org) + UCP/Shopify checks.
Per candidate: robots.txt first (error/403/timeout = disallow), then <=2 GETs: /.well-known/ucp and /products.json?limit=1 (only if robots allows)."""
import json, sys, time, urllib.request, urllib.robotparser, urllib.error, concurrent.futures as cf, datetime, ssl, re
from urllib.parse import urlparse
from ua import UA, UA_TOKEN
SHOP_ICONS = {"storefront","computer","local_mall","diamond","local_florist","photo_camera","local_grocery_store","phone_iphone",
  "checkroom","menu_book","sports_esports","pets","toys","liquor","wine_bar","shopping_cart","shopping_bag","store","local_offer","watch",
  "chair","hardware","bicycle","pedal_bike","card_giftcard","devices","smartphone","headphones","local_drink","directions_bike","eyeglasses","spa"}
def iso(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def get(url, n=200_000, t=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/plain,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=t) as r: return r.status, r.read(n).decode("utf-8","replace"), r.headers.get("content-type","")
    except urllib.error.HTTPError as e: return e.code, "", ""
    except Exception as e: return None, type(e).__name__, ""
def check(c):
    d = c["domain"]; base = "https://" + d; log = []
    st, txt, _ = get(base + "/robots.txt"); log.append(("/robots.txt", st))
    out = dict(c, ucp=None, shopify=None, robots_ok=False, robots_status=st, checked_at=iso(), requests=log)
    if st is None or st in (401, 403) or (st >= 500): out["why"] = f"robots-{st or txt}"; return out
    rp = urllib.robotparser.RobotFileParser(); rp.parse(txt.splitlines() if st == 200 else [])
    out["robots_ok"] = rp.can_fetch(UA_TOKEN, base + "/")
    if not out["robots_ok"]: out["why"] = "robots-disallow"; return out
    time.sleep(2)
    if rp.can_fetch(UA_TOKEN, base + "/.well-known/ucp"):
        s, b, ct = get(base + "/.well-known/ucp"); log.append(("/.well-known/ucp", s))
        try: j = json.loads(b) if s == 200 else None
        except Exception: j = None
        out["ucp"] = bool(j and isinstance(j, dict) and ("ucp" in j or "services" in j or "capabilities" in j))
        if out["ucp"]: out["ucp_doc"] = j
    time.sleep(2)
    if rp.can_fetch(UA_TOKEN, base + "/products.json?limit=1"):
        s, b, ct = get(base + "/products.json?limit=1"); log.append(("/products.json?limit=1", s))
        out["shopify"] = s == 200 and b.lstrip().startswith('{"products"')
    return out
def host(u):
    try:
        h = urlparse(u if "://" in u else "https://" + u).hostname or ""
        return h.lower().removeprefix("www.")
    except Exception: return ""
if __name__ == "__main__":
    places = json.load(open(sys.argv[1])); known = {json.loads(l)["d"] for l in open("out/records.v3.jsonl")}
    extra = [x.strip() for x in open(sys.argv[3]).read().split()] if len(sys.argv) > 3 else []
    social = re.compile(r"(facebook|instagram|twitter|x\.com|linktr|google|wa\.me|t\.me|youtube|tiktok|linkedin|yelp|tripadvisor|booking\.com|wix|square\.site|github)")
    seen = {}; 
    for d in extra: seen[d] = {"domain": d, "seed_source": "manual:lightning-giftcard-list", "name": None}
    for p in places:
        if p.get("icon") not in SHOP_ICONS or not p.get("website"): continue
        us = 24 < (p.get("lat") or 0) < 50 and -125 < (p.get("lon") or 0) < -66
        h = host(p["website"])
        if not h or h in known or h in seen or social.search(h) or "." not in h: continue
        seen[h] = {"domain": h, "seed_source": f"btcmap:place/{p['id']}", "name": p.get("name"), "icon": p["icon"], "us": us}
    cands = sorted(seen.values(), key=lambda c: (c["seed_source"].startswith("btcmap"), not c.get("us")))[: int(sys.argv[2])]
    with cf.ThreadPoolExecutor(24) as ex, open("out/seeds.v2.raw.jsonl", "w") as f:
        for r in ex.map(check, cands): f.write(json.dumps(r) + "\n"); f.flush()
