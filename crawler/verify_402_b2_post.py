#!/usr/bin/env python3
"""Batch-2 second probe for rows that answered GET with 401/404/405: the x402 Bazaar listing (or the 405) says POST, so send
ONE POST with an empty JSON body {} to the same endpoint. Same gate rules as verify_402.py (terms "ok", endpoint-host
robots.txt). Never pays, no auth headers. Updates out/verify-402.agent-native.b2.json in place (method recorded)."""
import json, os, sys, time, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import gate, verify_402 as v
from ua import UA
P = os.path.join(HERE, "out", "verify-402.agent-native.b2.json")
rows = json.load(open(P))
for row in rows:
    if row.get("result") != "no-402" or row.get("method") == "POST": continue
    v_ = gate.verdict(row["d"]) or {}
    if not gate._robots_ok(row["endpoint"]): continue
    gate._bypass.on = True
    try:
        req = urllib.request.Request(row["endpoint"], data=b"{}", method="POST",
                                     headers={"User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp: code, h, body = resp.status, resp.headers, resp.read(200000)
        except urllib.error.HTTPError as e: code, h, body = e.code, e.headers, e.read(200000)
        p = v.parse(code, h, body.decode("utf-8", "replace"))
        row["get_http"] = row.get("http")
        for k in ("http", "proto", "challenge", "price_seen", "x402Version"): row.pop(k, None)
        row.update(p, method="POST", result="verified-402" if p.get("proto") in ("l402", "x402") else "no-402", ts=int(time.time()))
    except Exception as e:
        row.update(method="POST", post_err=type(e).__name__ + ": " + str(e)[:160])
    finally: gate._bypass.on = False
    print(row["d"], row["result"], row.get("http"), row.get("price_seen", "")); time.sleep(1)
json.dump(rows, open(P, "w"), indent=1)
