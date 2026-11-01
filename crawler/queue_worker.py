#!/usr/bin/env python3
"""Path 3 queue worker: community-submitted domains -> gated crawl -> locally signed records -> status report.

  queue_worker.py [--queue URL|FILE] [--limit N] [--dry-run]

1. Reads the public queue (default https://klickymart.com/submit/queue.ndjson, state=pending) or a local NDJSON fixture.
2. For each domain: the gate blocklist / stored verdict first (gate.verdict); then tos.py, then crawl.py --require-tos, both of
   which go through gate.py (robots.txt first, an error or 403 = disallow, public pages only, no login, no orders, honest UA).
3. Builds the record locally (src=community, submission id, trust_tier=unverified) and signs it with sign_events.py into
   out/submissions/<run>/events.jsonl. It NEVER publishes to relays: records from submissions stay local until Matt OKs them.
4. Reports POST /submit/queue/{id}/status {crawled|refused|error, reason} with the token from $KM_INGEST_TOKEN (default /home/box/secrets/klickymart/ingest.token)
   (read by path, never printed or logged).
--dry-run: no store fetches, no crawl, no signing, no status POST; prints the plan per domain. Use with a local --queue file.
"""
import argparse, datetime, json, os, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
SITE = "https://klickymart.com"
TOKEN_PATH = os.environ.get("KM_INGEST_TOKEN", "/home/box/secrets/klickymart/ingest.token")
REFUSE = {"blocked-tos", "agents-not-welcome", "robots-disallowed"}

def read_queue(src):
    if src.startswith("https://"):
        req = urllib.request.Request(src, headers={"User-Agent": "FloppyKitMapBot/0.2 (+https://klickymart.com/bot; bot@klickymart.com)"})
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status != 200: raise RuntimeError(f"queue fetch: HTTP {r.status}")
            text = r.read().decode()
    else:
        text = open(src).read()
    return parse_queue(text)

def parse_queue(text):
    """NDJSON queue -> items. An empty 200 body means an empty queue (not an error). Bad lines are skipped, not fatal."""
    out = []
    for l in (text or "").splitlines():
        if not l.strip(): continue
        try: it = json.loads(l)
        except ValueError: print(f"skip non-JSON queue line: {l[:80]!r}", file=sys.stderr); continue
        if isinstance(it, dict) and "error" in it and "domain" not in it: raise RuntimeError(f"queue endpoint error: {it['error']}")
        if isinstance(it, dict): out.append(it)
    return out

def outcome(rec):
    """Map a crawl record to a queue status + reason."""
    if not rec: return "error", "crawl produced no record"
    st = rec.get("status") or ("error" if rec.get("err") else "crawled")
    if st in REFUSE: return "refused", f"{st}: {rec.get('why') or rec.get('tos') or ''}".strip(": ")[:300]
    if st == "crawled": return "crawled", "gated crawl ok; record signed locally, not published"
    return "error", (rec.get("err") or st)[:300]

def default_run(cmd):
    return subprocess.run([sys.executable] + cmd, cwd=HERE, capture_output=True, text=True, timeout=1800)

def report(item_id, status, reason, token_path=TOKEN_PATH, site=SITE, post=None):
    body = json.dumps({"status": status, "reason": reason}).encode()
    with open(token_path) as f: tok = f.read().strip()
    req = urllib.request.Request(f"{site}/submit/queue/{item_id}/status", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    try:
        if post: return post(req)
        with urllib.request.urlopen(req, timeout=30) as r: return r.status
    except urllib.error.HTTPError as e: return e.code
    finally: tok = None

def process(items, outdir, run=default_run, verdict=None, dry=False, post=None, log=print):
    if verdict is None:
        import gate; verdict = gate.verdict
    os.makedirs(outdir, exist_ok=True)
    results = []
    for it in items:
        d, sid = it.get("domain"), it.get("id")
        if not d or not sid: log(f"skip malformed queue item: {it}"); continue
        v = verdict(d) or {}
        if v.get("status") in REFUSE or v.get("tos") == "bans-automation":
            st, why = "refused", f"gate: {v.get('status')} ({v.get('src')})"
        elif dry:
            log(f"[dry-run] {d} ({sid}): would run tos.py, crawl.py --require-tos, sign locally, report status; no network")
            results.append({"id": sid, "domain": d, "status": "planned"}); continue
        else:
            sites = os.path.join(outdir, f"{d}.sites.json")
            json.dump([{"d": d, "cat": [it["category_hint"]] if it.get("category_hint") else []}], open(sites, "w"))
            dd = os.path.join(outdir, d)
            r1 = run(["tos.py", sites, "--out", dd])
            r2 = run(["crawl.py", sites, "--out", dd, "--require-tos", "--tos", os.path.join(dd, "tos.jsonl"), "--force"]) if r1.returncode == 0 else r1
            rec = None
            rp = os.path.join(dd, "records.jsonl")
            if os.path.exists(rp):
                for l in open(rp):
                    if l.strip(): rec = json.loads(l)
            if rec is None and r2.returncode != 0:
                st, why = "error", (r2.stderr or r2.stdout or "crawl failed")[-300:]
            else:
                st, why = outcome(rec)
            if rec is not None:
                rec.update(src="community", submission_id=sid, trust_tier="unverified", submitted_at=it.get("queued_at"))
                with open(os.path.join(outdir, "records.jsonl"), "a") as f: f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        results.append({"id": sid, "domain": d, "status": st, "reason": why})
        if dry: log(f"[dry-run] {d} ({sid}): would report {st}: {why}"); continue
        code = report(sid, st, why, post=post)
        log(f"{d}: {st} ({why}) -> status POST {code}")
    if not dry and os.path.exists(os.path.join(outdir, "records.jsonl")):
        r = run(["sign_events.py", os.path.join(outdir, "records.jsonl"), "--out", os.path.join(outdir, "events.jsonl")])
        log(f"signed locally (NOT published): {(r.stdout or '').strip()[-200:]}")
    with open(os.path.join(outdir, "results.json"), "w") as f: json.dump(results, f, indent=1)
    return results

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", default=f"{SITE}/submit/queue.ndjson?state=pending")
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    items = read_queue(a.queue)[: a.limit]
    if not items:
        print("queue empty: nothing to crawl, no status reports sent"); return 0
    run_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ("-dry" if a.dry_run else "")
    outdir = os.path.join(HERE, "out", "submissions", run_id)
    res = process(items, outdir, dry=a.dry_run)
    print(f"queue items={len(items)} results={len(res)} out={outdir}")

if __name__ == "__main__": main()
