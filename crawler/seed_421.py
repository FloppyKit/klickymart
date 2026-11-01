#!/usr/bin/env python3
"""Build UNSIGNED kind 421 'proof without purchase' seed templates from ucp_quote.py output (Matt decision 4, 2026-10-31).
A seed is level 1 only: /landed never counts the crawler key toward corroboration. Region is ZIP3 only.
Signing and publishing need Matt's separate OK; this script does neither.
Usage: python seed_421.py out/ucp-quotes-1031.json [--out out/seed-421.unsigned.jsonl]"""
import json, sys, time, argparse
AUTHOR = "3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242"
ap = argparse.ArgumentParser(); ap.add_argument("quotes"); ap.add_argument("--out", default="out/seed-421.unsigned.jsonl"); a = ap.parse_args()
z3 = json.load(open("probe.local.json"))["address"]["zip"][:3]
n = 0
with open(a.out, "w") as f:
    for d, q in json.load(open(a.quotes)).items():
        t = q.get("totals") or {}
        if not q.get("ok") or "subtotal" not in t or "fulfillment" not in t or "tax" not in t: continue
        c = (q.get("currency") or "USD"); m = lambda k: f"{t[k] / 100:.2f}"
        tags = [["a", f"31420:{AUTHOR}:{d}"], ["r", d], ["L", "klickymart.fulfillment"], ["l", "checkout-quote-seed", "klickymart.fulfillment"],
                ["proof", "checkout-quote-no-purchase"], ["level", "1"], ["region", z3], ["product", q.get("variant", "")],
                ["amount", "price_seen", m("subtotal"), c], ["amount", "shipping", m("fulfillment"), c], ["amount", "tax", m("tax"), c]]
        if "total" in t: tags.append(["amount", "total", m("total"), c])
        f.write(json.dumps({"kind": 421, "pubkey": AUTHOR, "created_at": int(time.time()), "tags": tags, "content": ""}) + "\n"); n += 1
print(f"{n} unsigned seed templates -> {a.out} (not signed, not published)")
