#!/usr/bin/env python3
"""Audit #16/#38 (2026-10-31): read each UCP store's public /.well-known/ucp once (gated: robots.txt + stored terms verdict
via gate.py, honest UA, 1 s pace) and keep only the declared protocol facts: version, capability names, payment handler
names, and whether AP2 / ACP are mentioned. No checkout, no account, no POST. Writes out/ucp-capabilities.json."""
import json, os, sys, time, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from ua import UA
import gate

def names(x):
    if isinstance(x, dict): return sorted(x.keys())
    if isinstance(x, list): return sorted({str(i.get("name") or i.get("id") or i) if isinstance(i, dict) else str(i) for i in x})
    return []

def facts(j):
    u = j.get("ucp", j) if isinstance(j, dict) else {}
    caps = names(u.get("capabilities")); ph = names(u.get("payment_handlers") or (j.get("payment") or {}).get("handlers") or u.get("payment", {}).get("handlers") if isinstance(u.get("payment"), dict) else u.get("payment_handlers"))
    blob = json.dumps(j).lower()
    return {"version": u.get("version"), "capabilities": caps[:60], "payment_handlers": ph[:30], "services": names(u.get("services"))[:20],
            "mentions_ap2": "ap2" in blob, "mentions_acp": "agentic_commerce" in blob or '"acp' in blob}

def main(domains):
    out = {}
    for d in domains:
        url = f"https://{d}/.well-known/ucp"; row = {"src": url, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        try:
            gate.check(url)
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=20) as r: j = json.loads(r.read(300000))
            row.update(ok=True, **facts(j))
        except gate.GateRefused as e: row.update(ok=False, why="gate: " + str(e)[:120])
        except urllib.error.HTTPError as e: row.update(ok=False, why=f"HTTP {e.code}")
        except Exception as e: row.update(ok=False, why=type(e).__name__)
        out[d] = row; print(d, row.get("ok"), row.get("version"), len(row.get("capabilities") or []), row.get("why", ""), flush=True); time.sleep(1)
    json.dump(out, open(os.path.join(HERE, "out", "ucp-capabilities.json"), "w"), indent=1)

if __name__ == "__main__": main(sys.argv[1].split(","))
