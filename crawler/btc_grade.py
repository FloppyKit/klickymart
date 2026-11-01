#!/usr/bin/env python3
"""Evidence-based bitcoin grading (CRAWL-RUBRIC.md). Never guesses: a grade is set only when a quote/URL supports it;
otherwise btc stays null with btc_grade_reason (and btc_grade_range when bounded). Hand grades (btc_src='hand') are kept.
Usage: btc_grade.py in.jsonl out.jsonl"""
import json, re, sys
BTC = {"btc", "ln", "liq", "cashu", "fedi", "ark", "sp", "bolt12", "lnurl"}
SELF = re.compile(r"(?i)btcpay|own (lightning )?node|self-hosted")
CUSTODIAL = re.compile(r"(?i)confirmo|opennode|strike|bitpay|coinbase commerce|zaprite|ibex|speed|blink|nowpayments|coingate")
FIAT_CONVERT = re.compile(r"(?i)crypto (debit )?card|via (an )?exchange|coinbase account|requires? (an )?account")
NOACCT_TEXT = re.compile(r"(?i)only the minimum (necessary )?shipping information|no account (is )?(needed|required)|without (creating )?an account|guest checkout")
PRIV = re.compile(r"(?i)cashu|ecash|fedimint|silent payments?|\bark\b")

def grade_record(r, probe=None):
    """Return (grade|None, info dict). info: src, quote, url, reason, range."""
    if r.get("btc_src") == "hand": return r.get("btc"), {"src": "hand"}
    quotes = [q for q in r.get("pay_q") or [] if q["c"] in BTC and not q.get("neg")]
    pm = [m for m in (probe or {}).get("methods") or [] if m["c"] in BTC]
    procs = (probe or {}).get("processors") or []
    if not quotes and not pm:
        if (probe or {}).get("step_reached") == "payment_methods":
            return 0, {"src": "agent-evidence", "quote": ", ".join(m["c"] for m in probe["methods"]) or "(no methods)",
                       "url": (probe.get("path") or [[None, None]])[-1][-1], "reason": "payment screen reached, no bitcoin option"}
        return None, {"reason": "no bitcoin payment evidence after context filter"}
    q = quotes[0] if quotes else None
    text = " ".join([x["q"] for x in quotes] + [m["ev"] for m in pm])
    url = q["url"] if q else (probe.get("path") or [[None, None]])[-1][-1]
    quote = q["q"] if q else pm[0]["ev"]
    label = re.escape((r.get("d") or "x").split(".")[-2] if "." in (r.get("d") or "") else "x")
    noacct = "noacct" in ((probe or {}).get("privacy") or []) or bool(NOACCT_TEXT.search(text))
    selfhosted = any(p.get("selfhosted") for p in procs) or bool(re.search(r"(?i)own (lightning )?node|self-hosted|our own (btcpay|server|node)|hosted by " + label + r"\b", text))
    btcpay = any(p["p"] == "btcpay" for p in procs) or bool(SELF.search(text))
    cust = [p["p"] for p in procs if p.get("custodial") and p["p"] != "stripe"] or CUSTODIAL.findall(text)
    if FIAT_CONVERT.search(text):
        return 1, {"src": "agent-evidence", "quote": quote, "url": url, "reason": "bitcoin only via card/exchange account"}
    if noacct and selfhosted:
        g = 4 if PRIV.search(text) else 3
        sq = next((x for x in quotes if re.search(r"(?i)hosted by|self-hosted|own (node|server|btcpay)", x["q"])), q)
        return g, {"src": "agent-evidence", "quote": sq["q"] if sq else quote, "url": sq["url"] if sq else url,
                   "reason": "no buyer account and merchant-hosted bitcoin checkout, per quote" + (" plus privacy features" if g == 4 else "")}
    if noacct and cust:
        return 2, {"src": "agent-evidence", "quote": quote, "url": url, "reason": f"guest checkout, custodial processor {cust[0]}"}
    if noacct and btcpay:
        return None, {"quote": quote, "url": url, "range": "2-3", "reason": "BTCPay seen with guest checkout; host ownership not verifiable without placing an order"}
    return None, {"quote": quote, "url": url, "range": "1-4", "reason": "bitcoin accepted; processor/custody and account requirement not evidenced"}

def apply(r, probe=None):
    g, info = grade_record(r, probe)
    out = dict(r)
    if info.get("src") == "hand": return out
    out["btc"] = g
    out["btc_any"] = bool(info.get("quote")) and g != 0
    out["btc_src"] = "agent-evidence" if g is not None else None
    out["btc_grade_quote"], out["btc_grade_url"] = info.get("quote"), info.get("url")
    out["btc_grade_reason"] = info.get("reason")
    if g is not None and g >= 3:
        out["btc_priv"] = sorted(set(out.get("btc_priv") or []) | {"noacct", "selfhosted"})
    if info.get("range"): out["btc_grade_range"] = info["range"]
    else: out.pop("btc_grade_range", None)
    return out

def main(src, dst, probes="out/checkout.jsonl"):
    import os
    pm = {}
    if os.path.exists(probes):
        for l in open(probes):
            if l.strip(): p = json.loads(l); pm[p["d"]] = p
    n = graded = 0
    with open(dst, "w") as f:
        for l in open(src):
            if not l.strip(): continue
            r = json.loads(l)
            if r.get("status") == "crawled" and (r.get("btc_any") or any(q["c"] in BTC for q in r.get("pay_q") or []) or r["d"] in pm):
                r = apply(r, pm.get(r["d"])); n += 1; graded += r.get("btc") is not None
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    print(f"evaluated={n} graded={graded} -> {dst}")
if __name__ == "__main__": main(*sys.argv[1:])
