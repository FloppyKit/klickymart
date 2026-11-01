#!/usr/bin/env python3
"""For records refused by robots.txt, re-read robots.txt (honest UA) and quote the exact group + Disallow line that applies to us."""
import json, re, sys, urllib.request
from ua import UA; TOKEN = "floppykitmapbot"
def groups(txt):
    gs, cur, last_ua = [], None, False
    for raw in txt.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line: continue
        k, v = [x.strip() for x in line.split(":", 1)]; k = k.lower()
        if k == "user-agent":
            if not last_ua: cur = {"ua": [], "rules": []}; gs.append(cur)
            cur["ua"].append(v); last_ua = True
        elif cur is not None:
            last_ua = False
            if k in ("disallow", "allow"): cur["rules"].append(f"{k.capitalize()}: {v}")
    return gs
def why(d):
    base = "https://" + (d if d.count(".") > 1 else "www." + d)
    txt = urllib.request.urlopen(urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA}), timeout=25).read().decode("utf-8", "replace")
    gs = groups(txt)
    g = next((g for g in gs if any(TOKEN in u.lower() for u in g["ua"])), None) or next((g for g in gs if "*" in g["ua"]), None)
    if not g: return {"group": None, "line": None}
    line = next((r for r in g["rules"] if r in ("Disallow: /", "Disallow: /*")), None) or next((r for r in g["rules"] if r.startswith("Disallow")), None)
    return {"group": "User-agent: " + ", ".join(g["ua"]), "line": line, "url": base + "/robots.txt"}
if __name__ == "__main__":
    recs = [json.loads(json.loads(l)["content"]) for l in open(sys.argv[1])]
    out = {}
    for r in recs:
        if (r.get("anw") or {}).get("type") == "robots-disallow":
            try: out[r["d"]] = why(r["d"])
            except Exception as e: out[r["d"]] = {"err": type(e).__name__}
            print(r["d"], out[r["d"]])
    json.dump(out, open(sys.argv[2], "w"), indent=1)
