#!/usr/bin/env python3
"""Write out/btc-candidates.txt: records with any BTC/crypto signal plus btcnative sites, minus ToS-banned."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from checkout_parse import is_candidate
def main(rec=os.path.join(HERE, "out", "records.jsonl"), dst=os.path.join(HERE, "out", "btc-candidates.txt")):
    native = {s["d"] for s in json.load(open(os.path.join(HERE, "sites.250.json"))) if "btcnative" in s.get("cat", [])}
    out, seen = [], set()
    for l in open(rec):
        if not l.strip(): continue
        r = json.loads(l)
        if r["d"] in seen or r.get("status") == "blocked-tos": continue
        if is_candidate(r, native): out.append(r["d"]); seen.add(r["d"])
    with open(dst, "w") as f: f.write("# btc checkout-probe candidates (signal in records or btcnative); ToS-banned excluded\n" + "\n".join(out) + "\n")
    print(f"candidates={len(out)} -> {dst}")
if __name__ == "__main__": main(*sys.argv[1:])
