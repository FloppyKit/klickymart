#!/usr/bin/env python3
"""Verify store-owned help pages that state guest-checkout policy: robots first (error/403 = skip), honest UA, quote must appear
on the page we fetched. Candidates were found by web search; only the store's own domain counts. Writes out/runs/guest-help-2026-10-30.json"""
import json, re, urllib.request, urllib.robotparser, html as H
from urllib.parse import urlparse
from ua import UA
C = [
 ("bestbuy.com", True, "https://www.bestbuy.com/site/help-topics/getting-receipt-copies/pcmcat204400050026.c?id=pcmcat204400050026", "If you make a purchase online and check out as a guest"),
 ("newegg.com", True, "https://kb.newegg.com/knowledge-base/how-to-place-an-order/?lang=en", "guests can choose Continue with Guest Checkout instead of signing in"),
 ("costco.com", False, "https://customerservice.costco.com/app/answers/detail/a_id/1131", "we do not offer guest checkout as an option"),
]
def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=30) as r: return r.status, r.read(3_000_000).decode("utf-8", "replace")
out = {}
for d, val, url, q in C:
    pu = urlparse(url); assert pu.netloc.endswith(d.split(".")[-2] + "." + d.split(".")[-1])
    try:
        st, rt = get(f"{pu.scheme}://{pu.netloc}/robots.txt")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403) or e.code >= 500: print(d, "robots", e.code, "-> skip"); continue
        rt = ""
    except Exception as e: print(d, "robots err", e, "-> skip"); continue
    rp = urllib.robotparser.RobotFileParser(); rp.parse(rt.splitlines())
    if not rp.can_fetch("FloppyKitMapBot", url): print(d, "robots disallows", url); continue
    try: st, page = get(url)
    except Exception as e: print(d, "fetch", e); continue
    text = H.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page)))
    ok = q.lower() in text.lower()
    print(d, st, "quote found" if ok else "QUOTE NOT FOUND")
    if ok: out[d] = {"guest": val, "url": url, "q": q}
json.dump(out, open("out/runs/guest-help-2026-10-30.json", "w"), indent=1)
