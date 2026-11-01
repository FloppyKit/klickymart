"""GO D1: product offers, deterministic only. Order per site (robots first, <=10 requests/site, >=2 s apart):
Shopify /products.json -> sitemap product URLs + schema.org Product/Offer JSON-LD. UCP Storefront Catalog is NOT stored:
Shopify's catalog usage guidelines forbid caching results, so UCP is used live only (Worker /offers). Never adds to cart."""
import json, re, sys, time, html, hashlib, datetime, gzip, urllib.request, urllib.error, urllib.robotparser, concurrent.futures as cf
from urllib.parse import urljoin, urlparse
from ua import UA, UA_TOKEN
MAX_REQ = 10
STOCK = {"instock": "in", "outofstock": "out", "preorder": "preorder", "backorder": "backorder", "soldout": "out", "limitedavailability": "in", "instoreonly": "out", "onlineonly": "in"}
COND = {"newcondition": "new", "usedcondition": "used", "refurbishedcondition": "refurb", "damagedcondition": "used"}
def iso(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
class Site:
    def __init__(s, d, base): s.d, s.base, s.n, s.log, s.rp = d, base, 0, [], None
    def get(s, url, n=4_000_000):
        if s.n >= MAX_REQ: return None, ""
        if s.rp is not None and not s.rp.can_fetch(UA_TOKEN, url): s.log.append((url, "robots-skip")); return "robots", ""
        if s.n: time.sleep(2)
        s.n += 1
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json,application/xml;q=0.9,*/*;q=0.5", "Accept-Language": "en-US"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                b = r.read(n)
                if url.endswith(".gz") or b[:2] == b"\x1f\x8b":
                    try: b = gzip.decompress(b)
                    except Exception: pass
                s.log.append((url, r.status)); return r.status, b.decode("utf-8", "replace")
        except urllib.error.HTTPError as e: s.log.append((url, e.code)); return e.code, ""
        except Exception as e: s.log.append((url, type(e).__name__)); return None, ""
def norm_stock(v):
    if not v: return None
    k = str(v).rsplit("/", 1)[-1].lower().replace("_", "")
    return STOCK.get(k)
def jsonld_blocks(page):
    for m in re.finditer(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', page, re.S | re.I):
        try: yield json.loads(html.unescape(m.group(1).strip()) if m.group(1).strip().startswith("&") else m.group(1).strip())
        except Exception:
            try: yield json.loads(re.sub(r"[\x00-\x1f]", " ", m.group(1)))
            except Exception: continue
def walk(o):
    if isinstance(o, list):
        for x in o: yield from walk(x)
    elif isinstance(o, dict):
        yield o
        for k in ("@graph", "mainEntity", "itemListElement", "item", "hasVariant"):
            if k in o: yield from walk(o[k])
def is_type(o, t):
    ty = o.get("@type"); ty = ty if isinstance(ty, list) else [ty]
    return any(isinstance(x, str) and x.lower().endswith(t.lower()) for x in ty)
def offers_from_jsonld(page, url, d):
    out = []
    for blk in jsonld_blocks(page):
        for p in walk(blk):
            if not is_type(p, "Product"): continue
            offs = p.get("offers"); offs = offs if isinstance(offs, list) else [offs] if offs else []
            flat = []
            for o in offs:
                if isinstance(o, dict) and is_type(o, "AggregateOffer") and o.get("offers"): flat += o["offers"] if isinstance(o["offers"], list) else [o["offers"]]
                else: flat.append(o)
            brand = p.get("brand"); brand = brand.get("name") if isinstance(brand, dict) else brand
            for o in flat[:5]:
                if not isinstance(o, dict): continue
                price = o.get("price") or o.get("lowPrice") or (o.get("priceSpecification") or {}).get("price") if isinstance(o.get("priceSpecification"), dict) else o.get("price") or o.get("lowPrice")
                try: price = round(float(str(price).replace(",", "")), 2)
                except Exception: continue
                if price <= 0: continue
                seller = o.get("seller"); seller = seller.get("name") if isinstance(seller, dict) else seller
                gtin = next((str(x) for x in (o.get("gtin13"), o.get("gtin12"), o.get("gtin14"), o.get("gtin"), p.get("gtin13"), p.get("gtin12"), p.get("gtin14"), p.get("gtin")) if x), None)
                out.append({"domain": d, "key": {"gtin": gtin, "mpn": o.get("mpn") or p.get("mpn"), "sku": o.get("sku") or p.get("sku"), "name": (p.get("name") or "")[:200], "brand": brand if isinstance(brand, str) else None},
                    "price": price, "cur": o.get("priceCurrency") or (o.get("priceSpecification") or {}).get("priceCurrency") if isinstance(o.get("priceSpecification"), dict) else o.get("priceCurrency"),
                    "stock": norm_stock(o.get("availability")), "cond": COND.get(str(o.get("itemCondition") or "").rsplit("/", 1)[-1].lower()),
                    "seller": seller if isinstance(seller, str) else None, "url": o.get("url") if isinstance(o.get("url"), str) and o["url"].startswith("http") else url,
                    "method": "jsonld", "src": url, "raw_jsonld_hash": hashlib.sha256(json.dumps(o, sort_keys=True).encode()).hexdigest()[:16]})
    return out
META = lambda page, prop: (re.search(r'<meta[^>]+(?:property|name|itemprop)=["\']' + re.escape(prop) + r'["\'][^>]*content=["\']([^"\']+)', page, re.I) or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name|itemprop)=["\']' + re.escape(prop) + r'["\']', page, re.I))
def offers_from_meta(page, url, d):
    """Fallback: Open Graph product price tags (og:price:amount / product:price:amount) or schema.org microdata itemprop=price."""
    for pa, pc in (("product:price:amount", "product:price:currency"), ("og:price:amount", "og:price:currency"), ("price", "priceCurrency")):
        a, c = META(page, pa), META(page, pc)
        if a and c:
            try: price = round(float(a.group(1).replace(",", "")), 2)
            except Exception: continue
            t = META(page, "og:title"); av = META(page, "product:availability") or META(page, "og:availability") or META(page, "availability")
            return [{"domain": d, "key": {"gtin": None, "mpn": None, "sku": None, "name": html.unescape(t.group(1))[:200] if t else "", "brand": None},
                     "price": price, "cur": c.group(1).upper()[:3], "stock": norm_stock(av.group(1).replace(" ", "")) if av else None, "cond": None, "seller": None,
                     "url": url, "method": "og-meta" if pa != "price" else "microdata", "src": url}]
    return []
def offers_from_shopify(js, base, d, src):
    out = []
    for p in js.get("products", []):
        for v in p.get("variants", [])[:3]:
            try: price = round(float(v.get("price")), 2)
            except Exception: continue
            out.append({"domain": d, "key": {"gtin": v.get("barcode") or None, "mpn": None, "sku": v.get("sku") or None, "name": (p.get("title", "") + ("" if v.get("title") in (None, "Default Title") else " - " + v["title"]))[:200], "brand": p.get("vendor")},
                "price": price, "cur": None, "stock": "in" if v.get("available") else "out" if v.get("available") is False else None, "cond": None, "seller": None,
                "url": f"{base}/products/{p.get('handle')}?variant={v.get('id')}", "method": "shopify-json", "src": src, "shopify_variant": v.get("id")})
    return out
FOREIGN = re.compile(r"/(?!en-us/|en/|us/)[a-z]{2}[-_][a-z]{2}/|/(de|fr|es|it|nl|ja|jp|ko|zh|pt|no|sv|da|fi|pl|uk|gb|ca|au|en-gb|en-ca|en-au)/", re.I)
LOC_RX = re.compile(r"<loc>\s*(.*?)\s*</loc>", re.I)
PRODUCT_URL = re.compile(r"/(product|products|p|dp|item|ip|itm|shop/[^/]+)/|/p/|\.html?$|-p-\d|/pd/|/sku", re.I)
def crawl(rec):
    d = rec["d"]; base = rec.get("base") or ("https://" + ("" if d.count(".") > 1 else "www.") + d)
    s = Site(d, base); res = {"domain": d, "offers": [], "why": None, "checked_at": iso()}
    st, txt = s.get(base + "/robots.txt")
    if st is None or st in (401, 403, 429) or (isinstance(st, int) and st >= 500):
        res["why"] = f"robots-{st}"; res["log"] = s.log; return res
    rp = urllib.robotparser.RobotFileParser(); rp.parse(txt.splitlines() if st == 200 else []); s.rp = rp
    if not rp.can_fetch(UA_TOKEN, base + "/"): res["why"] = "robots-disallow"; res["log"] = s.log; return res
    st, body = s.get(base + "/products.json?limit=250")
    if st == 200 and body.lstrip().startswith('{"products"'):
        try:
            offs = offers_from_shopify(json.loads(body), base, d, base + "/products.json?limit=250")
            # currency: Shopify /products.json has none; read it from one product's JSON-LD (1 request)
            if offs:
                st2, pg = s.get(offs[0]["url"].split("?")[0])
                ld = offers_from_jsonld(pg or "", offs[0]["url"], d)
                cur = next((o["cur"] for o in ld if o.get("cur")), None)
                for o in offs: o["cur"] = cur; o["cur_src"] = "jsonld-same-store" if cur else None
                res["offers"] += [o for o in offs if o["cur"]] + ld
                res["shopify"] = True
        except Exception as e: res["why"] = "shopify-parse"
    elif st == 429: res["why"] = "http-429"; res["log"] = s.log; return res
    if not res["offers"]:
        sm = [l.split(":", 1)[1].strip() for l in txt.splitlines() if l.lower().startswith("sitemap:")][:3] or [base + "/sitemap.xml"]
        urls = []
        for u in sm:
            if len(urls) >= 6 or s.n >= 5: break
            st, x = s.get(u, 8_000_000)
            if st != 200: continue
            locs = [l for l in LOC_RX.findall(x) if not FOREIGN.search(l)]
            subs = [l for l in locs if re.search(r"\.xml(\.gz)?$", l, re.I)]
            if subs and not any(PRODUCT_URL.search(l) for l in locs if l not in subs):
                prod = [l for l in subs if re.search(r"product|pdp|item|sku|shop", l, re.I)]
                if not prod: continue
                st, x = s.get(prod[0], 8_000_000); locs = [l for l in LOC_RX.findall(x) if not FOREIGN.search(l)] if st == 200 else []
            urls += [html.unescape(l) for l in locs if PRODUCT_URL.search(l) and not l.endswith((".xml", ".gz"))][:8]
        if len(urls) < 3 and s.n < MAX_REQ - 2:
            st, hp = s.get(base + "/")
            if st == 200:
                res["offers"] += offers_from_jsonld(hp, base + "/", d)
                hrefs = [urljoin(base + "/", html.unescape(h)) for h in re.findall(r'href="([^"#]+)"', hp)]
                hrefs = [h for h in dict.fromkeys(hrefs) if urlparse(h).hostname and urlparse(h).hostname.removeprefix("www.").endswith(d.removeprefix("www.")) and PRODUCT_URL.search(urlparse(h).path) and not FOREIGN.search(h)]
                urls += hrefs[:6]
        for u in urls[:MAX_REQ]:
            if s.n >= MAX_REQ: break
            st, pg = s.get(u)
            if st in (403, 429): res["why"] = f"http-{st}"; break
            if st == 200: res["offers"] += offers_from_jsonld(pg, u, d) or offers_from_meta(pg, u, d)
    ts = iso()
    for o in res["offers"]: o["checked_at"] = ts; o["match_conf"] = None
    res["log"] = s.log
    if not res["offers"] and not res["why"]: res["why"] = "no-structured-offers"
    return res
if __name__ == "__main__":
    recs = [json.loads(l) for l in open(sys.argv[1])]
    recs = [r for r in recs if r.get("status", "crawled") == "crawled"]
    if len(sys.argv) > 3 and sys.argv[3].startswith("@"): recs = [r for r in recs if r["d"] in set(open(sys.argv[3][1:]).read().split())]
    elif len(sys.argv) > 3: recs = [r for r in recs if r["d"] in set(sys.argv[3].split(","))]
    with cf.ThreadPoolExecutor(16) as ex, open(sys.argv[2], "w") as f:
        for r in ex.map(crawl, recs):
            f.write(json.dumps(r) + "\n"); f.flush(); print(r["domain"], len(r["offers"]), r["why"], flush=True)
