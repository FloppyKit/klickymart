#!/usr/bin/env python3
"""Batch-2 wrapper around verify_402.py: same rules (stored terms verdict "ok", robots.txt of the endpoint host, one honest
unauthenticated GET per endpoint, ever; never pays). Reads out/records.agent-native.b2.jsonl, writes
out/verify-402.agent-native.b2.json so batch 1's file is untouched."""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import verify_402 as v
_O = v.O
def O(*p):
    m = {"records.agent-native.jsonl": "records.agent-native.b2.jsonl", "verify-402.agent-native.json": "verify-402.agent-native.b2.json"}
    return _O(*[m.get(x, x) for x in p])
v.O = O
if __name__ == "__main__": v.main()
