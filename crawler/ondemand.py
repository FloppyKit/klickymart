#!/usr/bin/env python3
"""Drain KlickyMart's pending-check queue (https://klickymart.com/pending.json) into the normal pipeline:
tos.py (robots first, then terms) -> crawl.py --require-tos (public pages only) -> ship_policy.py. Domains whose terms ban
automation are recorded as such by build_v5.py and never crawled. Reads only our own public endpoint; no catalog data."""
import json, subprocess, sys, urllib.request
from ua import UA
src = sys.argv[1] if len(sys.argv) > 1 else "https://klickymart.com/pending.json"
j = json.load(urllib.request.urlopen(urllib.request.Request(src, headers={"User-Agent": UA}), timeout=20)) if src.startswith("http") else json.load(open(src))
known = {json.loads(l)["d"] for l in open("out/records.v5.jsonl")} if __import__("os").path.exists("out/records.v5.jsonl") else set()
new = [{"d": i["domain"], "seed_source": "live-catalog-on-demand"} for i in j["items"] if i["domain"] not in known][:50]
print(len(new), "pending domains")
if new:
    json.dump(new, open("sites.ondemand.json", "w"))
    py = ".venv/bin/python"
    subprocess.run([py, "tos.py", "sites.ondemand.json", "--out", "out/v5live"], check=False)
    subprocess.run([py, "crawl.py", "sites.ondemand.json", "--out", "out/v5live", "--tos", "out/v5live/tos.jsonl", "--require-tos", "--batch", "50"], check=False)
