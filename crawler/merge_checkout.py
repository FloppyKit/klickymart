#!/usr/bin/env python3
"""Merge out/checkout.jsonl into records -> out/records.merged.jsonl (records.jsonl is never modified).
Latest probe per domain wins."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from checkout_parse import merge
def main(rec=os.path.join(HERE, "out", "records.jsonl"), probes=os.path.join(HERE, "out", "checkout.jsonl"),
         dst=os.path.join(HERE, "out", "records.merged.jsonl")):
    latest = {}
    for l in open(probes):
        if l.strip():
            p = json.loads(l)
            if p["d"] not in latest or p["ts"] >= latest[p["d"]]["ts"]: latest[p["d"]] = p
    n = changed = 0
    with open(dst, "w") as out:
        for l in open(rec):
            if not l.strip(): continue
            r = json.loads(l); m = merge(r, latest.get(r["d"]))
            changed += m != r; n += 1
            out.write(json.dumps(m, separators=(",", ":")) + "\n")
    print(f"records={n} probed={len(latest)} changed={changed} -> {dst}")
if __name__ == "__main__": main(*sys.argv[1:])
