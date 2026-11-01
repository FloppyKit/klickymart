"""Round-1 item 10: gift-card denominations from public schema.org JSON-LD (AggregateOffer.offers) on gift-card stores.
Robots first, honest UA, <=6 requests/store. Prices are face values listed in the store's structured data; the amount
charged in BTC/Lightning may include a fee that is not in structured data, so it is reported as unknown."""
import json, re, sys, datetime, urllib.robotparser
from urllib.parse import urljoin
from offers import Site
iso = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
PAGES = {"bitrefill.com": ("https://www.bitrefill.com/", ["us/en/gift-cards/amazon_com-usa/", "us/en/gift-cards/uber-usa/", "us/en/gift-cards/apple-usa/", "us/en/gift-cards/doordash-usa/", "us/en/gift-cards/target-usa/"])}
out = []
for d, (base, paths) in PAGES.items():
    s = Site(d, base); st, rb = s.get(urljoin(base, "/robots.txt"))
    s.rp = urllib.robotparser.RobotFileParser(); s.rp.parse(rb.splitlines() if st == 200 else [])
    rows = []
    for p in paths:
        u = urljoin(base, p); st, h = s.get(u)
        if st != 200: continue
        for m in re.finditer(r'(?is)<script[^>]+application/ld\+json[^>]*>(.*?)</script>', h):
            try: j = json.loads(m.group(1))
            except Exception: continue
            if j.get("@type") != "Product": continue
            ag = j.get("offers") or {}
            for o in (ag.get("offers") or []):
                if o.get("priceCurrency") != "USD" or o.get("price") is None: continue
                rows.append({"domain": d, "key": {"gtin": None, "mpn": j.get("mpn"), "sku": f"{j.get('sku')}:{o['price']}", "name": f"{j.get('name')} ${o['price']:g} (face value)", "brand": (j.get("brand") or {}).get("name")},
                             "price": float(o["price"]), "cur": "USD", "stock": "in" if "InStock" in str(o.get("availability")) else None, "cond": "new", "seller": None,
                             "url": u, "method": "jsonld-aggregateoffer", "src": u, "checked_at": iso(),
                             "denomination": {"face_usd": float(o["price"]), "range": [ag.get("lowPrice"), ag.get("highPrice")], "count": ag.get("offerCount"),
                                              "fee": None, "note": "face value from the store's structured data; any fee charged when paying with bitcoin is not in structured data (unknown)"}})
    out.append({"domain": d, "offers": rows, "requests": s.log}); print(d, len(rows))
with open("out/giftcards.raw.jsonl", "w") as f:
    for x in out: f.write(json.dumps(x) + "\n")
