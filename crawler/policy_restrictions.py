"""Deterministic return-policy restriction heuristics (early shopper finding F8).
return_days alone is a summary; these pull the restrictions that change the deal, each with a verbatim quote:
no change-of-mind returns, short defect/damage report windows, restocking fees, final-sale wording,
plus conflicting return windows across the pages read. Pure functions over page text; no fetching."""
import re

def _sentences(t):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", t or "") if s.strip()]

def _q(s): return s[:200]

NO_CHANGE_OF_MIND = re.compile(r"(do not|don't|cannot|can't|no)\b[^.]{0,60}\b(change[- ]of[- ]mind|changed your mind|buyer'?s remorse|general returns?)|(change[- ]of[- ]mind|buyer'?s remorse)[^.]{0,40}\b(not (accepted|eligible|refundable)|no returns?)", re.I)
DEFECT_WINDOW = re.compile(r"(defect|damag|doa|dead on arrival|faulty|broken)[^.]{0,120}?within\s+(\d{1,3})\s*(?:business\s+)?days|within\s+(\d{1,3})\s*(?:business\s+)?days[^.]{0,80}(defect|damag|doa|faulty|broken)", re.I)
RESTOCK = re.compile(r"(\$\s?\d+(?:\.\d\d)?|\d{1,2}(?:\.\d+)?\s?%)[^.]{0,60}restock|restock(?:ing)?\s+fee[^.]{0,60}?(\$\s?\d+(?:\.\d\d)?|\d{1,2}(?:\.\d+)?\s?%)", re.I)
FINAL_SALE = re.compile(r"\b(final sale|all sales (are )?final|non-?returnable|not eligible for (a )?return)", re.I)
WINDOW = re.compile(r"\b(\d{1,3})[- ]day\s+(?:return|money[- ]back|trial|risk[- ]free)|(?:return|refund)s?[^.]{0,40}?within\s+(\d{1,3})\s+days", re.I)

def restrictions(text, url=None):
    out, seen = [], set()
    def add(kind, s, **kw):
        key = (kind, _q(s))
        if key in seen: return
        seen.add(key); out.append({"kind": kind, "q": _q(s), **({"url": url} if url else {}), **kw})
    for s in _sentences(text):
        if NO_CHANGE_OF_MIND.search(s): add("no-change-of-mind", s)
        m = DEFECT_WINDOW.search(s)
        if m: add("defect-window", s, days=int(m.group(2) or m.group(3)))
        m = RESTOCK.search(s)
        if m:
            amt = (m.group(1) or m.group(2) or "").replace(" ", "")
            add("restocking-fee", s, **({"usd": float(amt[1:])} if amt.startswith("$") else {"pct": float(amt[:-1])} if amt.endswith("%") else {}))
        if FINAL_SALE.search(s): add("final-sale", s)
    return out

def windows(text):
    return sorted({int(a or b) for a, b in WINDOW.findall(text or "") if (a or b) and 0 < int(a or b) <= 365})

def conflicting_sources(texts, summary_days=None):
    """texts = [(url, text)]. Returns [{url, days, q}] for windows that differ from summary_days (or from each other)."""
    per = []
    for u, t in texts:
        for s in _sentences(t):
            for a, b in WINDOW.findall(s):
                n = int(a or b)
                if 0 < n <= 365: per.append({"url": u, "days": n, "q": _q(s)})
    days = {p["days"] for p in per} | ({summary_days} if summary_days else set())
    if len(days) <= 1: return []
    seen, out = set(), []
    for p in per:
        if (p["url"], p["days"]) not in seen: seen.add((p["url"], p["days"])); out.append(p)
    return out

def analyze(texts, summary_days=None):
    r = []
    for u, t in texts: r.extend(restrictions(t, u))
    return {"return_restrictions": r, "conflicting_sources": conflicting_sources(texts, summary_days)}
