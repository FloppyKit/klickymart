"""M4 S1: the gate that must pass BEFORE the crawl is widened to more websites (Matt 2026-11-01: "pre-crawl").
Pure checks over local files only (no network, no keys):
  1. allow-list: every target domain has a precrawl row with decision "crawl"; robots must allow and terms must not
     ban automation; amazon.com / target.com are always skipped (link-out only, M4 decision).
  2. per-domain rate limit: planned requests <= MAX_REQ_PER_DOMAIN per day, spacing >= max(MIN_SPACING_S, crawl-delay).
  3. budget headroom: today's usage (km-status.sh output) + the projected run stays under 50% of each daily limit.
  4. CI green on HEAD (km-status CHECK ci_green_on_head PASS).
  5. stop rule: the previous run's blocked share (ar/blocked/error) must be <= MAX_BLOCKED_SHARE.
Exit 0 only when every check passes; each failure prints one FAIL line."""
import json, re, sys, argparse

LINK_ONLY = {"amazon.com", "target.com"}
MAX_REQ_PER_DOMAIN = 10
MIN_SPACING_S = 2.0
MAX_BLOCKED_SHARE = 0.10
CAP = 0.50
# Projection per crawled domain: Worker requests 0 (box crawler); D1 writes <= 7 rows (5 trust signals + ship + queue).
D1_WRITES_PER_DOMAIN = 7

def norm(d: str) -> str:
    d = d.strip().lower()
    return d[4:] if d.startswith("www.") else d

def link_only(d: str) -> bool:
    d = norm(d)
    return any(d == x or d.endswith("." + x) for x in LINK_ONLY)

def check_allow(domains, rows):
    by = {norm(r.get("d", "")): r for r in rows}
    fails = []
    for d in domains:
        n = norm(d)
        if link_only(n): fails.append(f"{n}: link-out only (Amazon/Target are never crawled)"); continue
        r = by.get(n)
        if r is None: fails.append(f"{n}: no precrawl row"); continue
        if r.get("decision") != "crawl": fails.append(f"{n}: precrawl decision {r.get('decision')!r}"); continue
        if r.get("robots_allows") is not True: fails.append(f"{n}: robots does not allow (status {r.get('robots_status')})"); continue
        if r.get("tos") == "bans-automation": fails.append(f"{n}: terms ban automation")
    return fails

def robots_decision(status, allows):
    """Same rule as site/worker/src/recheck.ts:50-51: 200 -> parsed result; other 4xx (not 401/403/429) -> no robots file
    -> allowed; 401/403/429/5xx/timeout(None) -> disallow."""
    if status == 200: return bool(allows)
    if status is not None and 400 <= status < 500 and status not in (401, 403, 429): return True
    return False

def check_rate(plan):
    fails = []
    for p in plan:
        d, n = norm(p["d"]), int(p.get("requests", 0))
        sp = float(p.get("spacing_s", 0)); cd = float(p.get("crawl_delay_s") or 0)
        if n > MAX_REQ_PER_DOMAIN: fails.append(f"{d}: {n} requests > {MAX_REQ_PER_DOMAIN}/day")
        need = max(MIN_SPACING_S, cd)
        if sp < need: fails.append(f"{d}: spacing {sp}s < {need}s")
    return fails

USAGE_RX = re.compile(r"^\s*(Workers requests|DO requests|DO duration GB-s|D1 rows read|D1 rows written)\s+([\d,.]+)\s*/\s*([\d,]+)", re.M)

def parse_status(text):
    usage = {m.group(1): (float(m.group(2).replace(",", "")), float(m.group(3).replace(",", ""))) for m in USAGE_RX.finditer(text)}
    ci = re.search(r"CHECK ci_green_on_head: (\w+)", text)
    return usage, (ci.group(1) if ci else None)

def check_budget(usage, n_domains):
    need = {"Workers requests", "D1 rows written", "D1 rows read"}
    missing = sorted(need - usage.keys())
    if missing: return [f"usage unknown for {', '.join(missing)} (km-status output incomplete)"]
    proj = {"D1 rows written": n_domains * D1_WRITES_PER_DOMAIN, "D1 rows read": n_domains * D1_WRITES_PER_DOMAIN}
    fails = []
    for k, (used, lim) in usage.items():
        tot = used + proj.get(k, 0)
        if tot > CAP * lim: fails.append(f"{k}: {tot:,.0f} projected > 50% of {lim:,.0f}")
    return fails

def check_stop(last_run):
    if not last_run: return []
    tot = int(last_run.get("total", 0)); bad = int(last_run.get("blocked", 0)) + int(last_run.get("error", 0))
    if tot and bad / tot > MAX_BLOCKED_SHARE: return [f"last run blocked/error {bad}/{tot} > {MAX_BLOCKED_SHARE:.0%}: no widening today"]
    return []

def gate(domains, rows, plan, status_text, last_run=None):
    usage, ci = parse_status(status_text)
    fails = check_allow(domains, rows) + check_rate(plan) + check_budget(usage, len(domains)) + check_stop(last_run)
    if ci != "PASS": fails.append(f"CI on HEAD: {ci or 'unknown'} (need PASS)")
    planned = {norm(p["d"]) for p in plan}
    fails += [f"{norm(d)}: no rate plan" for d in domains if norm(d) not in planned and not link_only(d)]
    return fails

def _jsonl(path):
    with open(path) as f: return [json.loads(l) for l in f if l.strip()]

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--domains", required=True, help="one domain per line: the widened target list")
    ap.add_argument("--precrawl", required=True, help="out/precrawl-YYYYMMDD.jsonl")
    ap.add_argument("--plan", required=True, help="jsonl rows {d, requests, spacing_s, crawl_delay_s}")
    ap.add_argument("--status", required=True, help="saved km-status.sh output")
    ap.add_argument("--last-run", help="json {total, blocked, error} from the previous batch")
    a = ap.parse_args(argv)
    domains = [l.strip() for l in open(a.domains) if l.strip() and not l.startswith("#")]
    last = json.load(open(a.last_run)) if a.last_run else None
    fails = gate(domains, _jsonl(a.precrawl), _jsonl(a.plan), open(a.status).read(), last)
    for f in fails: print("FAIL", f)
    print(f"widen-gate: {'PASS' if not fails else 'FAIL'} ({len(domains)} domains, {len(fails)} failures)")
    return 0 if not fails else 1

if __name__ == "__main__":
    sys.exit(main())
