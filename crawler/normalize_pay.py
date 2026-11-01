#!/usr/bin/env python3
"""Normalization step: dedupe payment codes and evidence, and give each code a distinct display label.
Root cause of the doubled 'Buy now pay later' chip: bnpl:afterpay and bnpl:klarna are distinct codes, but the label
lookup stripped the ':provider' suffix, so both rendered as the same label; and chips concatenate the online, in-store
and unscoped lists, so a code present in two lists rendered twice. Usage: normalize_pay.py IN.jsonl OUT.jsonl"""
import json, sys
PAY_LISTS = ("pay", "pay_online", "pay_instore", "pay_unscoped", "pay_no")
LABELS = {"card": "Card", "apay": "Apple Pay", "gpay": "Google Pay", "spay": "Shop Pay", "pp": "PayPal", "venmo": "Venmo",
          "cashapp": "Cash App", "zelle": "Zelle", "ach": "Bank transfer (ACH)", "check": "Check", "cod": "Cash on delivery",
          "gift": "Gift card", "ebt": "EBT", "hsa": "HSA/FSA", "bnpl": "Buy now pay later", "btc": "Bitcoin (on-chain)",
          "ln": "Lightning", "cashu": "Cashu", "usdc": "USDC", "usdt": "USDT", "eth": "Ethereum", "ltc": "Litecoin", "crypto": "Crypto"}

def uniq(xs):
    seen, out = set(), []
    for x in xs or []:
        k = json.dumps(x, sort_keys=True) if isinstance(x, dict) else x
        if k not in seen: seen.add(k); out.append(x)
    return out

def label(code):
    base, _, sub = code.partition(":")
    if base not in LABELS: return code
    return LABELS[base] + (f" ({sub.capitalize()})" if sub else "")

def chip_labels(rec):
    """Unique display labels across online, in-store and unscoped lists (order preserved)."""
    return uniq(label(c) for c in (rec.get("pay_online") or []) + (rec.get("pay_instore") or []) + (rec.get("pay_unscoped") or []))

def normalize(rec):
    r = dict(rec)
    for k in PAY_LISTS:
        if isinstance(r.get(k), list): r[k] = uniq(r[k])
    for k in ("pay_q", "evu"):
        if isinstance(r.get(k), list): r[k] = uniq(r[k])
    return r

if __name__ == "__main__":
    src, dst = sys.argv[1:3]; n = 0
    with open(dst, "w") as f:
        for l in open(src):
            if not l.strip(): continue
            a = json.loads(l); b = normalize(a); n += a != b; f.write(json.dumps(b) + "\n")
    print(f"changed={n}")
