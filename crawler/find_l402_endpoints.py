#!/usr/bin/env python3
"""Find public L402 endpoints on a candidate's own docs pages (gated: robots first, terms verdict ok, honest UA, 3 s pace,
<= 4 pages per site). Writes out/l402-endpoints.json. Never calls an API."""
import json, os, re, sys, time, urllib.request, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from ua import UA
import gate
SITES = sys.argv[1].split(",")
EP = re.compile(r"https?://[a-z0-9.-]+/[a-z0-9./_-]*(?:l402|api|v1)[a-z0-9./_-]*", re.I)
res = {}
for d in SITES:
    pages, found = [f"https://{d}/", f"https://{d}/llms.txt"], set()
    seen = 0
    while pages and seen < 4:
        u = pages.pop(0); seen += 1
        try:
            gate.check(u)
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=20) as r: html = r.read(500000).decode("utf-8", "replace")
        except Exception as e:
            res.setdefault(d, {}).setdefault("fetch", {})[u] = type(e).__name__; time.sleep(3); continue
        res.setdefault(d, {}).setdefault("fetch", {})[u] = 200
        found |= {m.rstrip(".") for m in EP.findall(html) if urllib.parse.urlsplit(m).hostname.endswith(d)}
        if seen == 1:
            for h in re.findall(r'href="([^"]+)"', html):
                if re.search(r"(?i)docs|developer|/api\b|l402", h):
                    full = urllib.parse.urljoin(u, h)
                    if urllib.parse.urlsplit(full).hostname and urllib.parse.urlsplit(full).hostname.endswith(d) and full not in pages: pages.append(full)
        time.sleep(3)
    res[d]["endpoints"] = sorted(found)
    print(d, res[d]["endpoints"][:10])
json.dump(res, open(os.path.join(HERE, "out", "l402-endpoints.json"), "w"), indent=1)
