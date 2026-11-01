"""Status policy: agents-not-welcome only for affirmative refusals; network/timeout failures are errors.
Pure functions (no network). Used by robots_triage.py to rewrite records."""
import re

AFFIRMATIVE = {"robots-disallow", "robots-403", "robots-429", "robots-block-page", "http-403", "http-429", "block-page"}
CAUSES = {"dns", "timeout", "tls", "connect", "5xx", "4xx", "redirect-loop", "decode", "unknown"}
BLOCK_TITLES = re.compile(r"(?i)access denied|just a moment|attention required|bot or not|request could not be satisfied|forbidden|captcha|are you a robot|pardon our interruption")

def classify_fetch(status=None, exc=None, body="", content_type=""):
    """One robots.txt fetch -> (kind, cause). kind in ok | not-found | refused | error.
    status: int HTTP code or None; exc: exception class name or message when no response."""
    if exc is not None:
        e = exc.lower()
        if any(k in e for k in ("gaierror", "name or service", "nodename", "name resolution", "err_name_not_resolved", "dns")): return "error", "dns"
        if "redirect" in e: return "error", "redirect-loop"
        if any(k in e for k in ("ssl", "tls", "certificate", "err_cert")): return "error", "tls"
        if "timeout" in e or "timed out" in e: return "error", "timeout"
        if "unicode" in e or "decode" in e: return "error", "decode"
        if any(k in e for k in ("refused", "reset", "unreachable", "connection")): return "error", "connect"
        return "error", "unknown"
    if status == 200:
        if "html" in (content_type or "").lower() and BLOCK_TITLES.search(body[:3000] if body else ""):
            return "refused", "block-page"
        return "ok", None
    if status in (403, 401): 
        return "refused", "block-page" if BLOCK_TITLES.search(body[:3000] if body else "") else "403"
    if status == 429: return "refused", "429"
    if status in (404, 410): return "not-found", None
    if status and 500 <= status < 600: return "error", "5xx"
    if status and 300 <= status < 400: return "error", "redirect-loop"
    if status and 400 <= status < 500: return "error", "4xx"
    return "error", "unknown"

def combine(results):
    """Several attempts (original + retries) -> one verdict. Any affirmative refusal wins; any success means robots readable."""
    kinds = [k for k, _ in results]
    refused = [c for k, c in results if k == "refused"]
    if refused:   # most specific refusal wins: block page > 429 > 403
        for c in ("block-page", "429", "403"):
            if c in refused: return "refused", c
    for k, c in results:
        if k in ("ok", "not-found"): return k, c
    causes = [c for k, c in results if k == "error" and c != "unknown"]
    return "error", (causes[-1] if causes else "unknown")

def reclassify(rec, verdict, evidence):
    """Rewrite status/anw/ar of a robots-failure record from a triage verdict.
    verdict = (kind, cause). 'ok'/'not-found' -> record flagged for re-crawl (status unchanged, rec['recrawl']=True)."""
    r = dict(rec); kind, cause = verdict
    url = (rec.get("anw") or {}).get("url")
    ar = [a for a in rec.get("ar") or [] if a.get("at") != "robots" or a.get("c") in ("rb_ai", "rb_ck")]
    if kind == "refused":
        t = {"403": "robots-403", "429": "robots-429", "block-page": "robots-block-page"}[cause]
        r["status"] = "agents-not-welcome"
        r["anw"] = {"type": t, "status": evidence.get("status"), "url": url, "q": evidence.get("q"), "triage": evidence}
        ar.append({"c": "403" if cause == "403" else ("429" if cause == "429" else "block"), "at": "robots", "ev": url, "n": f"robots.txt {cause}"})
    elif kind == "error":
        r["status"] = "error"
        r["anw"] = {"type": "robots-unreachable", "cause": cause, "status": evidence.get("status"), "url": url, "q": None, "triage": evidence}
        ar.append({"c": "net", "at": "robots", "ev": url, "n": f"robots.txt unreachable: {cause}"})
    else:
        r["recrawl"] = True; r.setdefault("anw", {}); r["anw"] = dict(r["anw"] or {}, triage=evidence)
    r["ar"] = ar
    return r
