#!/usr/bin/env python3
"""Offline: re-run extract.py over saved rendered text (out/text) for existing records. No network.
Writes out/records.reextract.jsonl (does not touch records.jsonl). Usage: python reextract.py [out]"""
import json, os, sys, glob
from extract import extract_payments, scope_split
out = sys.argv[1] if len(sys.argv) > 1 else "out"
res = []
tosm = {}
if os.path.exists(os.path.join(out, "tos.jsonl")):
    for l in open(os.path.join(out, "tos.jsonl")):
        t = json.loads(l); tosm[t["d"]] = t
for l in open(os.path.join(out, "records.jsonl")):
    r = json.loads(l); texts = []
    for f in sorted(glob.glob(os.path.join(out, "text", r["d"] + "_*.txt"))):
        step = os.path.basename(f)[len(r["d"]) + 1:].split("_")[0]
        url, title, _, *body = open(f).read().split("\n")
        texts.append((url, step, title, "\n".join(body)))
    if texts and r.get("status") != "blocked-tos":
        pay, no, q = extract_payments(texts)
        r["pay"], r["pay_no"], r["pay_q"] = pay, no, q
        r["pay_online"], r["pay_instore"], r["pay_unscoped"] = scope_split(q)
        r["evu"] = sorted({x["url"] for x in q})
        r["btc_any"] = any(p in pay for p in ("btc","ln","liq","cashu","fedi","ark","sp","bolt12","lnurl"))
        r["reextracted"] = "0.3-draft"
    t = tosm.get(r["d"])
    if t and r.get("status") != "blocked-tos":
        r["tos"] = t["tos"]; r["tos_url"] = t.get("url"); r["tos_q"] = t.get("q"); r["tos_q_lead"] = t.get("q_lead")
    for k in ("pay_online", "pay_instore", "pay_unscoped"):
        if r.get(k) is None: r[k] = []
    res.append(r)
with open(os.path.join(out, "records.reextract.jsonl"), "w") as f:
    for r in res: f.write(json.dumps(r, separators=(",", ":")) + "\n")
print(f"{len(res)} records -> {out}/records.reextract.jsonl")
