#!/usr/bin/env python3
"""Pay methods from a store's own home-page payment icons (Shopify themes render <title id="pi-...">Shop Pay</title> etc.).
Robots first, honest UA, 2 requests/store. Output out/v5live/paymarks.jsonl with the matched icon text as the quote."""
import json, re, sys, datetime, urllib.robotparser, html
from offers import Site
iso = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
ICON = {"shopify_pay": "spay", "apple_pay": "apay", "google_pay": "gpay", "paypal": "pp", "venmo": "venmo", "visa": "card", "master": "card", "american_express": "card",
        "discover": "card", "amazon": "oth", "klarna": "bnpl:klarna", "afterpay": "bnpl:afterpay", "affirm": "bnpl:affirm", "bitcoin": "btc", "litecoin": "ltc", "dogecoin": "crypto", "ethereum": "eth", "facebook_pay": "oth", "meta_pay": "oth", "union_pay": "card", "diners_club": "card", "jcb": "card", "link": "link"}
WALLET = {"dev.shopify.shop_pay": "spay", "com.google.pay": "gpay", "com.apple.pay": "apay", "dev.shopify.card": "card", "com.paypal": "pp", "dev.shopify.paypal": "pp", "com.amazon.pay": "oth", "dev.shopify.venmo": "venmo"}
from ua import UA as crawl_ua
out = open("out/v5live/paymarks.jsonl", "w")
for l in open(sys.argv[1]):
    r = json.loads(l)
    if r.get("status") != "crawled": continue
    d = r["d"]; base = f"https://{'' if d.count('.') > 1 else 'www.'}{d}/"
    s = Site(d, base); st, rb = s.get(base + "robots.txt")
    if st not in (200, 404): continue
    s.rp = urllib.robotparser.RobotFileParser(); s.rp.parse(rb.splitlines() if st == 200 else [])
    st, h = s.get(base); h = h or ""
    ids = sorted(set(re.findall(r'(?:id|aria-labelledby)="pi-([a-z_]+)"', h)))
    codes = {ICON[i] for i in ids if i in ICON}
    quotes = [" ".join(f'id="pi-{i}"' for i in ids)] if ids else []
    # v2: a product page's accelerated-checkout wallet list (payment="dev.shopify.shop_pay com.google.pay ...") and PayPal metadata.
    m = re.search(r'href="(?:https?://[^"/]*' + re.escape(d) + r')?(/products/[^"?#]+)', h)
    psrc = None
    if m:
        purl = base.rstrip("/") + m.group(1)
        if s.rp.can_fetch(crawl_ua, purl):
            pst, ph = s.get(purl); ph = html.unescape(ph or "")
            w = re.search(r'payment="([a-z0-9_. ]+)"', ph)
            if w:
                for tok in w.group(1).split(): 
                    if tok in WALLET: codes.add(WALLET[tok])
                quotes.append(w.group(0)); psrc = purl
            pp = re.search(r'id="paypal-metadata"[^>]*', ph) or re.search(r'paypal-metadata"[^>]*', ph)
            if pp: codes.add("pp"); quotes.append(pp.group(0)[:120]); psrc = purl
    codes = sorted(codes)
    res = {"d": d, "checked_at": iso(), "src": base, "src_product": psrc, "icons": ids, "pay": codes, "method": "home-page payment icons + a product page's accelerated-checkout wallet list (Shopify)", "q": " | ".join(quotes)[:300],
           "link_note": "Link (Stripe) is not a Shopify Payments wallet; not observed" if psrc else None}
    out.write(json.dumps(res) + "\n"); print(d, codes, flush=True)
