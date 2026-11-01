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
BTC_PROCESSORS = {"btcpay", "opennode", "strike", "bitpay", "zaprite", "ibex", "blink", "speed", "confirmo", "coingate", "nowpayments", "coinbase", "coinbase commerce"}
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
    """'observed': probe reached the payment screen AND itself showed bitcoin: a BTC method, or a bitcoin processor
    (P1-2: a card-only payment screen must not launder page-text bitcoin claims into 'observed')."""
    p = probe or {}
    if p.get("step_reached") != "payment_methods": return False
    return any(m.get("c") in BTC for m in p.get("methods") or []) or \
        any((x.get("p") or "").lower() in BTC_PROCESSORS for x in p.get("processors") or [])

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
    """UTC calendar date of x (date, datetime, or ISO string incl. offset/Z). Naive values are UTC. None if unreadable.
    P2-6: the full string is parsed (no [:10] truncation), so an offset moves the date correctly."""
    if x is None or x == "": return None
    if isinstance(x, datetime.datetime): dt = x
    elif isinstance(x, datetime.date): return x
    else:
        try: dt = datetime.datetime.fromisoformat(str(x).strip().replace("Z", "+00:00"))
        except (TypeError, ValueError): return None
    if dt.tzinfo is None: dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).date()

# Starting guess, modeled on the v9.2 event created_at skew check: a hand_at further than this in the future is an anomaly.
HAND_AT_SKEW = datetime.timedelta(minutes=10)

def _dt(x):
    """Aware UTC datetime of x (date-only -> midnight UTC), or None."""
    if x is None or x == "": return None
    if isinstance(x, datetime.datetime): dt = x
    elif isinstance(x, datetime.date): dt = datetime.datetime(x.year, x.month, x.day)
    else:
        try: dt = datetime.datetime.fromisoformat(str(x).strip().replace("Z", "+00:00"))
        except (TypeError, ValueError): return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)).astimezone(datetime.timezone.utc)

def _today(today=None):
    """Injectable 'today'; defaults to the UTC date (not box-local)."""
    return _date(today) or datetime.datetime.now(datetime.timezone.utc).date()

def _hand_start(r, today=None):
    """Start of the hand review window: hand_at clamped to today (a future hand_at never pins), else for an undated
    override the first-seen date (btc_grade_hand_first_seen, else today)."""
    t = _today(today)
    seen = min(_date(r.get("btc_grade_hand_first_seen")) or t, t)
    at = _date(r.get("btc_grade_hand_at"))
    return min(at, seen) if at is not None else seen   # future hand_at clamps to first-seen (persisted), never re-clamps

def hand_review_by(r, today=None):
    """ISO date: (hand_at, clamped to today; or first-seen for undated overrides) + 90 days."""
    return (_hand_start(r, today) + datetime.timedelta(days=HAND_REVIEW_DAYS)).isoformat()

# Rule: protection is earned by a date and evidence, and a missing date never buys a permanent lock.
# Satoshi 2026-10-31: an undated hand override is KEPT but only for 90 days from when this code first saw it
# (btc_grade_hand_first_seen); a disagreeing probe in that window flags btc_grade_needs_review. New undated overrides are
# still refused at write time (validate_hand_override).
def hand_protected(r, today=None):
    """True while a hand grade may not be overwritten: before review_by."""
    if r.get("btc_src") != "hand": return False
    return _today(today) < _date(hand_review_by(r, today))

def mark_first_seen(out, today=None, anomaly_sink=None):
    """Persist btc_grade_hand_first_seen (once) for an undated or future-dated hand override, so the clamp cannot
    move forward on later passes. Returns True when undated."""
    at = _date(out.get("btc_grade_hand_at"))
    now = _dt(today) or datetime.datetime.now(datetime.timezone.utc)
    at_dt = _dt(out.get("btc_grade_hand_at"))
    future = at_dt is not None and at_dt - now > HAND_AT_SKEW
    if at is None or at > _today(today) or future:
        # n-2: the operator-side store is the source of truth; the record field is a cache. Earliest value wins.
        import hand_first_seen
        k = hand_first_seen.key(out.get("d"), out.get("btc_grade_hand_by"), out.get("btc_grade_hand_at"))
        cands = [v for v in (hand_first_seen.get(k), out.get("btc_grade_hand_first_seen")) if _date(v)]
        fs = min(_date(v) for v in cands).isoformat() if cands else _today(today).isoformat()
        out["btc_grade_hand_first_seen"] = hand_first_seen.put(k, fs)
    if future:
        a = {"kind": "future_hand_at", "hand_at": out.get("btc_grade_hand_at"), "hand_by": out.get("btc_grade_hand_by"),
             "clamped_to": out["btc_grade_hand_first_seen"], "seen_at": now.isoformat()}
        # append-only history, never cleared (not even by a post-review overwrite); one entry per (kind, hand_at, hand_by)
        hist = out["btc_grade_anomalies"] = list(out.get("btc_grade_anomalies") or [])
        if not any((x.get("kind"), x.get("hand_at"), x.get("hand_by")) == (a["kind"], a["hand_at"], a["hand_by"]) for x in hist):
            hist.append(a)
            out["btc_grade_needs_review"] = True
        (anomaly_sink or _default_anomaly_sink)({"author": a["hand_by"], "domain": out.get("d"), "kind": a["kind"],
                                                 "hand_at": a["hand_at"], "clamped_to": a["clamped_to"], "seen_at": a["seen_at"]})
    return at is None

def _default_anomaly_sink(entry):
    """Ledger of anomalous hand overrides by author (hand_anomalies.py; idempotent). Decoupled from the record's flag."""
    import hand_anomalies
    hand_anomalies.record(entry)

def _redact_url(u):
    """P2-7: conflict urls are site-controlled; store them with userinfo/query stripped (egress.redact, the shared helper)."""
    if not u: return u
    try:
        import egress; return egress.redact(u)
    except Exception: return str(u).split("?", 1)[0].split("#", 1)[0]

def _evidence_urls(ev):
    evs = ev if isinstance(ev, (list, tuple)) else [ev]
    return [e for e in evs if isinstance(e, str) and re.match(r"https?://\S+$", e)]

def validate_hand_override(r, today=None):
    """Write-time check for a new hand override: needs a readable btc_grade_hand_at and evidence URL(s). Raises ValueError."""
    at = _date(r.get("btc_grade_hand_at"))
    if at is None: raise ValueError("hand override needs a readable btc_grade_hand_at")
    if at > _today(today): raise ValueError("hand override btc_grade_hand_at is in the future")   # P2-b
    ev = r.get("btc_grade_hand_evidence")
    if not ev or not _evidence_urls(ev) or len(_evidence_urls(ev)) != len(ev if isinstance(ev, (list, tuple)) else [ev]):
        raise ValueError("hand override needs evidence URL(s) in btc_grade_hand_evidence")

def write_hand_override(r, log=print, today=None, **fields):
    """Apply a hand override to record r only if it validates; otherwise skip it with a logged reason (never raises).
    Returns True when written."""
    cand = dict(r); cand.update(fields, btc_src="hand", btc_grade_basis=BASIS_HAND)
    try: validate_hand_override(cand, today)
    except ValueError as e:
        log(f"{r.get('d') or '?'}: hand override skipped: {e}"); return False
    cand["btc_grade_hand_review_by"] = hand_review_by(cand, today)
    r.update(cand); return True

def note_conflict(out, probe_grade, probe_basis, probe_url, today=None, undated=False):
    """Keep the hand grade; record a disagreeing concrete probe instead of dropping it (url redacted). Agreement clears it;
    an inconclusive (None) probe leaves any existing record alone. Undated overrides also get btc_grade_needs_review."""
    if probe_grade is None: return out
    if probe_grade == out.get("btc"):
        out.pop("btc_grade_conflict", None); return out
    out["btc_grade_conflict"] = {"hand": {"grade": out.get("btc"), "basis": BASIS_HAND},
                                 "probe": {"grade": probe_grade, "basis": probe_basis, "url": _redact_url(probe_url)},
                                 "seen_at": _today(today).isoformat()}
    out["btc_grade_needs_review"] = True   # Satoshi 2026-10-31: any recorded conflict, dated or not
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

def apply(r, probe=None, today=None, anomaly_sink=None):
    """today (date or ISO str) is injectable for tests; defaults to the UTC date."""
    out = dict(r)
    if r.get("btc_src") == "hand":
        undated = mark_first_seen(out, today, anomaly_sink)
        out["btc_grade_hand_review_by"] = hand_review_by(out, today)
        pg, pinfo = grade_record({k: v for k, v in r.items() if k != "btc_src"}, probe)
        if hand_protected(out, today):
            out["btc_grade_basis"] = BASIS_HAND   # a hand grade is never 'observed', whatever the probe saw
            for k in ("btc_grade_hand_by", "btc_grade_hand_at", "btc_grade_hand_evidence"): out.setdefault(k, None)
            return note_conflict(out, pg, pinfo.get("basis"), pinfo.get("url"), today, undated)
        # review_by reached: normal rules, but an inconclusive (None) result never erases a hand grade (P2-a)
        if pg is None: out["btc_grade_basis"] = BASIS_HAND; return out
        out.pop("btc_grade_conflict", None); out.pop("btc_grade_needs_review", None)
        return _apply_graded(out, pg, pinfo)
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
