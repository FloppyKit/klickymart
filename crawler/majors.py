"""Round-1 item 11: offers from major retailers' product pages via public JSON-LD only. Robots first, honest UA, <=10 requests/store,
no circumvention (a block, 403 or protocol error is logged as a finding, never retried with tricks). Product URLs come from the
store's own sitemaps (preferring headphone pages)."""
import json, re, sys, gzip, datetime, urllib.robotparser
from urllib.parse import urljoin
from offers import Site
iso = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
WANT = re.compile(r"(?i)headphone|ace|quietcomfort|wh-?1000|earbud|airpods")
def locs(x): return re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", x)
def products(h, u):
    out = []
    for m in re.finditer(r'(?is)<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h):
        try: j = json.loads(m.group(1).strip())
        except Exception: continue
        for p in (j if isinstance(j, list) else j.get("@graph", [j])):
            if not isinstance(p, dict) or "Product" not in str(p.get("@type")): continue
            offs = p.get("offers") or {}
            offs = offs if isinstance(offs, list) else (offs.get("offers") or [offs])
            for o in offs:
                if not isinstance(o, dict): continue
                pr = o.get("price") or o.get("lowPrice")
                try: pr = float(pr)
                except Exception: continue
                if pr <= 0: continue
                br = p.get("brand"); br = br.get("name") if isinstance(br, dict) else br
                out.append({"key": {"gtin": p.get("gtin13") or p.get("gtin12") or p.get("gtin"), "mpn": p.get("mpn"), "sku": p.get("sku"), "name": p.get("name"), "brand": br},
                            "price": pr, "cur": o.get("priceCurrency"), "stock": "in" if "InStock" in str(o.get("availability")) else ("out" if "OutOfStock" in str(o.get("availability")) else None),
                            "cond": "new", "seller": None, "url": u, "method": "jsonld", "src": u, "checked_at": iso()})
                break
    return out
def run(d, base, sitemaps):
    s = Site(d, base); st, rb = s.get(urljoin(base, "/robots.txt"))
    res = {"domain": d, "offers": [], "findings": []}
    if st not in (200, 404): res["findings"].append(f"robots.txt {st}: treated as disallow"); return res
    s.rp = urllib.robotparser.RobotFileParser(); s.rp.parse(rb.splitlines() if st == 200 else [])
    urls = []
    for sm in sitemaps:
        st, x = s.get(sm)
        if st != 200: res["findings"].append(f"sitemap {sm}: {st}"); continue
        ls = locs(x)
        sub = [l for l in ls if l.endswith((".xml", ".xml.gz"))]
        if sub and not urls:
            pick = [l for l in sub if re.search(r"(?i)pdp|product", l)][:1] or sub[:1]
            st, x2 = s.get(pick[0]); ls = locs(x2) if st == 200 else []
            if st != 200: res["findings"].append(f"sitemap {pick[0]}: {st}")
        urls += [l for l in ls if not l.endswith((".xml", ".xml.gz"))]
        if urls: break
    urls = sorted(set(urls), key=lambda u: (not WANT.search(u), u))
    for u in urls:
        if s.n >= 10: break
        st, h = s.get(u)
        if st == "robots": continue
        if st != 200: res["findings"].append(f"{u}: {st}"); continue
        got = products(h, u)
        if not got: res["findings"].append(f"{u}: 200 but no Product/Offer JSON-LD")
        res["offers"] += got
    res["requests"] = s.log; return res
T = {"sonos.com": ("https://www.sonos.com/", ["https://www.sonos.com/en-us/sitemap.xml"]),
     "bestbuy.com": ("https://www.bestbuy.com/", ["https://sitemaps.bestbuy.com/sitemaps_pdp.xml"]),
     "walmart.com": ("https://www.walmart.com/", ["https://www.walmart.com/sitemap_ip.xml"]),
     "costco.com": ("https://www.costco.com/", ["https://www.costco.com/sitemap_lw_index.xml"]),
     "dell.com": ("https://www.dell.com/", ["https://www.dell.com/en-us/sitemap.xml"])}
if __name__ == "__main__":
    import concurrent.futures as cf
    with cf.ThreadPoolExecutor(5) as ex, open("out/majors.raw.jsonl", "w") as f:
        for r in ex.map(lambda kv: run(kv[0], *kv[1]), T.items()):
            f.write(json.dumps(r) + "\n"); print(r["domain"], len(r["offers"]), r["findings"][:4], flush=True)
