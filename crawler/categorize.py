#!/usr/bin/env python3
"""Coarse `category` for kind 31420 records (CASCADE GO 5.6). Derived from the existing fine `cat` codes plus per-domain
knowledge for marketplaces and bitcoin-native sites. Writes unsigned draft updates and a site-side map; signs nothing.
Usage: categorize.py <records.ndjson> <updates.jsonl> <category-map.json>"""
import json, sys
CATEGORIES = ["electronics", "gift-cards", "groceries", "apparel", "hardware", "books", "travel", "crypto-hardware", "other"]
FROM_CAT = {"elec": ["electronics"], "gift": ["gift-cards"], "groc": ["groceries"], "food": ["groceries"], "appr": ["apparel"],
            "jewel": ["apparel"], "beau": ["other"], "home": ["hardware"], "craft": ["hardware"], "office": ["hardware"],
            "auto": ["hardware"], "book": ["books"], "trav": ["travel"], "tix": ["travel"], "sw": ["other"], "sport": ["apparel"],
            "pet": ["other"], "toy": ["other"]}
GENERAL = ["electronics", "apparel", "hardware", "books", "groceries", "gift-cards", "other"]
DOMAIN = {
    "amazon.com": GENERAL, "walmart.com": GENERAL, "target.com": GENERAL, "costco.com": GENERAL, "samsclub.com": GENERAL,
    "ebay.com": ["electronics", "apparel", "hardware", "books", "other"], "etsy.com": ["apparel", "gift-cards", "other"],
    "temu.com": ["electronics", "apparel", "hardware", "other"], "aliexpress.com": ["electronics", "apparel", "hardware", "other"],
    "alibaba.com": ["electronics", "hardware", "other"], "dhgate.com": ["electronics", "apparel", "other"], "wish.com": ["electronics", "apparel", "other"],
    "shein.com": ["apparel"], "kohls.com": ["apparel", "other"], "macys.com": ["apparel"], "jcpenney.com": ["apparel"],
    "nordstrom.com": ["apparel"], "nordstromrack.com": ["apparel"], "neimanmarcus.com": ["apparel"], "qvc.com": ["apparel", "electronics", "other"],
    "hsn.com": ["apparel", "electronics", "other"], "rakuten.com": ["other"], "craigslist.org": ["other"], "discogs.com": ["other"],
    "tcgplayer.com": ["other"], "vinted.com": ["apparel"], "mercari.com": ["electronics", "apparel", "other"], "poshmark.com": ["apparel"],
    "depop.com": ["apparel"], "thredup.com": ["apparel"], "therealreal.com": ["apparel"], "stockx.com": ["apparel"], "whatnot.com": ["other"],
    "steampowered.com": ["other"], "gog.com": ["other"], "g2a.com": ["gift-cards", "other"], "humblebundle.com": ["other"],
    "dyson.com": ["electronics"], "tesla.com": ["other"], "redbubble.com": ["apparel"], "teepublic.com": ["apparel"],
    "shutterfly.com": ["other"], "zazzle.com": ["apparel", "other"], "vistaprint.com": ["other"], "cafepress.com": ["apparel"],
    "starbucks.com": ["groceries", "gift-cards"],
    # bitcoin-native
    "shop.ledger.com": ["crypto-hardware"], "shop.trezor.io": ["crypto-hardware"], "store.blockstream.com": ["crypto-hardware"],
    "coinkite.com": ["crypto-hardware"], "store.coinkite.com": ["crypto-hardware"], "cryptocloaks.com": ["crypto-hardware", "apparel"],
    "foundation.xyz": ["crypto-hardware"], "start9.com": ["crypto-hardware"], "bitkey.world": ["crypto-hardware"], "nodl.it": ["crypto-hardware"],
    "satoshistore.io": ["crypto-hardware", "apparel"], "bitcoinstore.com": ["crypto-hardware", "apparel"],
    "bitrefill.com": ["gift-cards"], "coincards.com": ["gift-cards"], "thebitcoincompany.com": ["gift-cards"], "fold.me": ["gift-cards"],
    "bitcoinmagazine.com": ["books", "apparel"],
    "primal.net": ["other"], "swanbitcoin.com": ["other"], "river.com": ["other"], "fountain.fm": ["other"], "strike.me": ["other"],
    "bisq.network": ["other"], "hodlhodl.com": ["other"], "opennode.com": ["other"],
}
def classify(r):
    if r["d"] in DOMAIN: return DOMAIN[r["d"]], "domain-knowledge"
    out = []
    for c in r.get("cat") or []:
        for k in FROM_CAT.get(c, ["other"]):
            if k not in out: out.append(k)
    return (out or ["other"]), "from-cat"
if __name__ == "__main__":
    src, upd, mp = sys.argv[1:4]; m = {}; n = 0
    with open(upd, "w") as f:
        for l in open(src):
            if not l.strip(): continue
            r = json.loads(l); cats, how = classify(r)
            assert all(c in CATEGORIES for c in cats), (r["d"], cats)
            m[r["d"]] = cats
            r2 = dict(r); r2["category"] = cats; r2["category_src"] = how
            f.write(json.dumps(r2) + "\n"); n += 1
    json.dump({"v": "2026-10-29", "categories": CATEGORIES, "map": m}, open(mp, "w"), indent=0, sort_keys=True)
    from collections import Counter
    print(n, Counter(c for v in m.values() for c in v))
