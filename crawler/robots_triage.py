#!/usr/bin/env python3
"""Triage robots.txt failures: retry each once with a 30 s timeout via plain HTTP (urllib) and Playwright request,
same UA. Writes out/robots-triage.jsonl and out/records.triaged.jsonl (records.jsonl untouched). No page crawling."""
import json, os, sys, time, urllib.request, urllib.error, socket, ssl
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import crawl
from status_policy import classify_fetch, combine, reclassify
TIMEOUT = 30

class NoRedirectLoop(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

def plain(url):
    req = urllib.request.Request(url, headers={"User-Agent": crawl.UA})
    try:
        with urllib.request.build_opener(NoRedirectLoop).open(req, timeout=TIMEOUT) as r:
            body = r.read(20000).decode("utf-8", "replace")
            return {"via": "urllib", "status": r.status, "ctype": r.headers.get("content-type", ""), "final": r.url, "body": body}
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read(20000).decode("utf-8", "replace")
        except Exception: pass
        if 300 <= e.code < 400: return {"via": "urllib", "exc": f"redirect loop {e.code}"}
        return {"via": "urllib", "status": e.code, "ctype": e.headers.get("content-type", ""), "body": body}
    except urllib.error.URLError as e:
        return {"via": "urllib", "exc": f"{type(e.reason).__name__}: {e.reason}"}
    except (socket.timeout, TimeoutError) as e: return {"via": "urllib", "exc": f"timeout: {e}"}
    except Exception as e: return {"via": "urllib", "exc": f"{type(e).__name__}: {e}"}

def browser_req(ctx, url):
    try:
        r = ctx.request.get(url, timeout=TIMEOUT * 1000, max_redirects=5)
        return {"via": "playwright", "status": r.status, "ctype": r.headers.get("content-type", ""), "body": r.text()[:20000]}
    except Exception as e:
        return {"via": "playwright", "exc": f"{type(e).__name__}: {str(e)[:160]}"}

def offline(src, log):
    """Re-apply the policy to an existing triage log without any network (verdicts recomputed from logged attempts).
    A robots.txt readable by plain HTTP but not by the crawler (e.g. decode errors) stays an error: we cannot honour it."""
    out = {}
    for l in open(log):
        if not l.strip(): continue
        e = json.loads(l); orig = e["original"]
        first = classify_fetch(status=orig) if isinstance(orig, int) else classify_fetch(exc=str(orig))
        v = combine([first] + [(a["kind"], a["cause"]) for a in e["retries"]])
        if v[0] in ("ok", "not-found") and first[0] == "error": v = ("error", first[1])
        e["verdict"] = list(v); out[e["d"]] = (v, e)
    return out

def write(src, out, dst):
    recs = [json.loads(l) for l in open(src) if l.strip()]
    with open(dst, "w") as f:
        for r in recs:
            if r["d"] in out: r = reclassify(r, *out[r["d"]])
            f.write(json.dumps(r, separators=(",", ":")) + "\n")

def main(src=os.path.join(HERE, "out", "records.jsonl")):
    recs = [json.loads(l) for l in open(src) if l.strip()]
    targets = [r for r in recs if (r.get("anw") or {}).get("type") in ("robots-error", "robots-unreachable")]
    from playwright.sync_api import sync_playwright
    out = {}
    with sync_playwright() as pw, open(os.path.join(HERE, "out", "robots-triage.jsonl"), "w") as log:
        ctx = pw.chromium.launch(headless=True).new_context(user_agent=crawl.UA)
        for r in targets:
            url = r["anw"].get("url")
            orig = r["anw"].get("status")
            first = classify_fetch(status=orig) if isinstance(orig, int) else classify_fetch(exc=str(orig))
            tries = []
            for fn in (lambda: plain(url), lambda: browser_req(ctx, url)):
                time.sleep(2)
                a = fn(); a["kind"], a["cause"] = classify_fetch(a.get("status"), a.get("exc"), a.get("body", ""), a.get("ctype", ""))
                tries.append(a)
            verdict = combine([first] + [(a["kind"], a["cause"]) for a in tries])
            ev = {"original": orig, "retries": [{k: a.get(k) for k in ("via", "status", "exc", "kind", "cause")} for a in tries],
                  "verdict": list(verdict), "ts": crawl.now(), "timeout_s": TIMEOUT}
            ttl = next((a["body"] for a in tries if a.get("body") and "<title" in a["body"].lower()), "")
            if ttl:
                import re; m = re.search(r"(?is)<title[^>]*>(.*?)</title>", ttl); ev["q"] = (m.group(1).strip()[:120] if m else None)
            out[r["d"]] = (verdict, ev)
            log.write(json.dumps({"d": r["d"], **ev}) + "\n"); log.flush()
            print(r["d"], verdict, [(a["via"], a.get("status") or a.get("exc", "")[:40]) for a in tries], flush=True)
    with open(os.path.join(HERE, "out", "records.triaged.jsonl"), "w") as f:
        for r in recs:
            if r["d"] in out: r = reclassify(r, *out[r["d"]])
            f.write(json.dumps(r, separators=(",", ":")) + "\n")

if __name__ == "__main__":
    if sys.argv[1:2] == ["--offline"]:
        o = offline(os.path.join(HERE, "out", "records.jsonl"), os.path.join(HERE, "out", "robots-triage.jsonl"))
        write(os.path.join(HERE, "out", "records.jsonl"), o, os.path.join(HERE, "out", "records.triaged.jsonl"))
    else: main(*sys.argv[1:])
