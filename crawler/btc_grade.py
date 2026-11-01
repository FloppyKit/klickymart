#!/usr/bin/env python3
"""Evidence-based bitcoin grading (CRAWL-RUBRIC.md). Never guesses: a grade is set only when a quote/URL supports it;
otherwise btc stays null with btc_grade_reason (and btc_grade_range when bounded). Hand grades (btc_src='hand') are kept.
Usage: btc_grade.py in.jsonl out.jsonl"""
import datetime, json, re, sys
BTC = {"btc", "ln", "liq", "cashu", "fedi", "ark", "sp", "bolt12", "lnurl"}
SELF = re.compile(r"(?i)btcpay|own (lightning )?node|self-hosted")
CUSTODIAL = re.compile(r"(?i)confirmo|opennode|strike|bitpay|coinbase commerce|zaprite|ibex|speed|blink|nowpayments|coingate")
FIAT_CONVERT = re.compile(r"(?i)crypto (debit )?card|via (an )?exchange|coinbase account|requires? (an )?account")
NOACCT_TEXT = re.compile(r"(?i)only the minimum (necessary )?shipping information|no account (is )?(needed|required)|without (creating )?an account|guest checkout")
PRIV = re.compile(r"(?i)cashu|ecash|fedimint|silent payments?|\bark\b")

# Basis of a grade, highest first. No numeric weights: basis only breaks ties within a grade.
BASIS_BOUND = "bound"        # signed endpoint binding resolving when probed. NOT IMPLEMENTED: never emitted yet (hook: bound_basis)
BASIS_OBSERVED = "observed"  # checkout probe reached the payment screen and saw a method/processor
BASIS_HAND = "hand"          # set by a person/agent by hand (btc_src='hand'); never 'observed'. Records btc_grade_hand_by/_at/_evidence
BASIS_CLAIMED = "claimed"    # page text only
BASIS_ORDER = (BASIS_BOUND, BASIS_OBSERVED, BASIS_HAND, BASIS_CLAIMED)   # order confirmed by Satoshi 2026-10-31
CLAIMED_CAP = 2              # default scorer: basis 'claimed' caps at 2; 3 and 4 need 'observed' or 'bound'

def bound_basis(r, probe=None):
    """Hook for 'bound' (signed endpoint binding that resolves when probed). Not implemented: always False."""
    return False

def probe_observed(probe):
    """'observed': probe reached the payment screen and its methods or processors are non-empty."""
    p = probe or {}
    return p.get("step_reached") == "payment_methods" and bool(p.get("methods") or p.get("processors"))

def grade_basis(r, probe=None):
    if bound_basis(r, probe): return BASIS_BOUND
    return BASIS_OBSERVED if probe_observed(probe) else BASIS_CLAIMED

def grade_sort_key(grade, basis, hand_evidence=None):
    """Sort key (ascending = best first): grade first (higher better, None last), basis breaks ties
    (bound > observed > hand > claimed). A 'hand' grade with no evidence url/note (btc_grade_hand_evidence) sorts with claimed;
    its basis label stays 'hand'."""
    if basis == BASIS_HAND and not hand_evidence: basis = BASIS_CLAIMED
    return (grade is None, -(grade if grade is not None else 0), BASIS_ORDER.index(basis) if basis in BASIS_ORDER else len(BASIS_ORDER))

HAND_REVIEW_DAYS = 90       # a hand grade is protected until btc_grade_hand_review_by = hand_at + 90 days

def _date(x):
    if isinstance(x, datetime.datetime): return x.date()
    if isinstance(x, datetime.date): return x
    try: return datetime.date.fromisoformat(str(x)[:10])
    except (TypeError, ValueError): return None

def hand_review_by(r):
    """ISO date hand_at + 90 days, or None when hand_at is missing/unparseable."""
    at = _date(r.get("btc_grade_hand_at"))
    return (at + datetime.timedelta(days=HAND_REVIEW_DAYS)).isoformat() if at else None

# Rule: protection is earned by a date and evidence, and a missing date never buys a permanent lock.
# An undated hand override (no readable btc_grade_hand_at) FAILS OPEN: it counts as already past review_by.
def hand_protected(r, today=None):
    """True while a hand grade may not be overwritten: before review_by. Undated hand grades are never protected."""
    if r.get("btc_src") != "hand": return False
    rb = hand_review_by(r)
    if rb is None: return False
    return _date(today or datetime.date.today()) < _date(rb)

def _evidence_urls(ev):
    evs = ev if isinstance(ev, (list, tuple)) else [ev]
    return [e for e in evs if isinstance(e, str) and re.match(r"https?://\S+$", e)]

def validate_hand_override(r):
    """Write-time check for a new hand override: needs a readable btc_grade_hand_at and evidence URL(s). Raises ValueError."""
    if _date(r.get("btc_grade_hand_at")) is None: raise ValueError("hand override needs a readable btc_grade_hand_at")
    ev = r.get("btc_grade_hand_evidence")
    if not ev or not _evidence_urls(ev) or len(_evidence_urls(ev)) != len(ev if isinstance(ev, (list, tuple)) else [ev]):
        raise ValueError("hand override needs evidence URL(s) in btc_grade_hand_evidence")

def write_hand_override(r, log=print, **fields):
    """Apply a hand override to record r only if it validates; otherwise skip it with a logged reason (never raises).
    Returns True when written."""
    cand = dict(r); cand.update(fields, btc_src="hand", btc_grade_basis=BASIS_HAND)
    try: validate_hand_override(cand)
    except ValueError as e:
        log(f"{r.get('d') or '?'}: hand override skipped: {e}"); return False
    cand["btc_grade_hand_review_by"] = hand_review_by(cand)
    r.update(cand); return True

def note_conflict(out, probe_grade, probe_basis, probe_url, today=None):
    """Keep the hand grade; record a disagreeing probe instead of dropping it. Agreement (or an inconclusive probe) clears it."""
    if probe_grade is None or probe_grade == out.get("btc"):
        out.pop("btc_grade_conflict", None); return out
    out["btc_grade_conflict"] = {"hand": {"grade": out.get("btc"), "basis": BASIS_HAND},
                                 "probe": {"grade": probe_grade, "basis": probe_basis, "url": probe_url},
                                 "seen_at": _date(today or datetime.date.today()).isoformat()}
    return out

def grade_record(r, probe=None):
    """Return (grade|None, info dict). info: src, quote, url, reason, range, basis (every non-hand result)."""
    if r.get("btc_src") == "hand": return r.get("btc"), {"src": "hand", "basis": BASIS_HAND}
    g, info = _grade_text(r, probe)
    if g == 0 and info.get("src") == "agent-evidence" or g == 1:
        info["basis"] = BASIS_CLAIMED   # downgrades stand at 'claimed'
        return g, info
    basis = grade_basis(r, probe)
    info["basis"] = basis
    if g is not None and g > CLAIMED_CAP and basis == BASIS_CLAIMED:
        info.pop("src", None)
        info["range"] = "3-4 claimed"
        info["reason"] = "claimed by page text only: " + info["reason"] + "; 3-4 needs an observed checkout or bound endpoint"
        return None, info
    return g, info

def _grade_text(r, probe=None):
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

def apply(r, probe=None, today=None):
    """today (date or ISO str) is injectable for tests; defaults to date.today()."""
    out = dict(r)
    if r.get("btc_src") == "hand":
        out["btc_grade_hand_review_by"] = hand_review_by(r)
        if hand_protected(r, today):
            out["btc_grade_basis"] = BASIS_HAND   # a hand grade is never 'observed', whatever the probe saw
            for k in ("btc_grade_hand_by", "btc_grade_hand_at", "btc_grade_hand_evidence"): out.setdefault(k, None)
            pg, pinfo = grade_record({k: v for k, v in r.items() if k != "btc_src"}, probe)
            return note_conflict(out, pg, pinfo.get("basis"), pinfo.get("url"), today)
        undated = out["btc_grade_hand_review_by"] is None
        old_hand = r.get("btc")
        r = {k: v for k, v in r.items() if k != "btc_src"}   # review_by reached (or undated: fail open): grade normally
        out.pop("btc_grade_conflict", None)
        if undated:   # keep the old hand value next to the new one when the overwrite changes it
            g, info = grade_record(r, probe)
            res = _apply_graded(out, g, info)
            if g != old_hand:
                res["btc_grade_conflict"] = {"hand": {"grade": old_hand, "basis": BASIS_HAND},
                                             "probe": {"grade": g, "basis": info.get("basis"), "url": info.get("url")},
                                             "seen_at": _date(today or datetime.date.today()).isoformat()}
            return res
    g, info = grade_record(r, probe)
    return _apply_graded(out, g, info)

def _apply_graded(out, g, info):
    out["btc"] = g
    out["btc_any"] = bool(info.get("quote")) and g != 0
    out["btc_src"] = "agent-evidence" if g is not None else None
    out["btc_grade_quote"], out["btc_grade_url"] = info.get("quote"), info.get("url")
    out["btc_grade_reason"] = info.get("reason")
    out["btc_grade_basis"] = info.get("basis")   # always published with the grade
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
