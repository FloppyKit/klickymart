#!/usr/bin/env python3
"""10% stratified hand spot-check helper (2026-10-29). Re-fetches robots.txt, home, ToS and pay-evidence pages with the
crawler's honest UA and compares against records.final.jsonl. Public pages only; robots error/401/403 => disallow."""
import json, os, random, re, sys, time, urllib.robotparser
HERE = os.path.dirname(os.path.abspath(__file__))
from ua import UA; TOKEN = "FloppyKitMapBot"
QUOTA = {"crawled": 12, "agents-not-welcome": 7, "blocked-tos": 4, "error": 2}
norm = lambda s: re.sub(r"\s+", " ", (s or "").replace("\u00a0", " ")).strip().lower()

def sample(recs, seed=20261029):
    rnd = random.Random(seed); out = []
    for st, n in QUOTA.items(): out += rnd.sample(sorted([r for r in recs if r["status"] == st], key=lambda r: r["d"]), n)
    return out

def check(ctx, r):
    d = r["d"]; base = "https://" + (d if d.count(".") > 1 else "www." + d); o = {"d": d, "rec_status": r["status"]}
    rp = urllib.robotparser.RobotFileParser()
    try:
        x = ctx.request.get(base + "/robots.txt", timeout=20000); o["robots"] = x.status
        txt = x.text() if x.ok else ""; blockish = bool(re.search(r"(?i)access denied|just a moment|<html", txt[:2000]))
    except Exception as e: o["robots"] = "err:" + type(e).__name__; txt = ""; blockish = False
    if o["robots"] == 200 and not blockish: rp.parse(txt.splitlines())
    elif isinstance(o["robots"], int) and 400 <= o["robots"] < 500 and o["robots"] not in (401, 403): rp.parse([])
    else: rp.parse(["User-agent: *", "Disallow: /"])
    if o["robots"] == 200 and blockish: o["robots"] = "200-block-page"
    o["home_allowed"] = rp.can_fetch(TOKEN, base + "/")
    def get(page, url):
        if not rp.can_fetch(TOKEN, url): return "robots-disallow", ""
        time.sleep(3)
        try:
            resp = page.goto(url, timeout=30000, wait_until="domcontentloaded"); page.wait_for_timeout(2500)
            return (resp.status if resp else None), page.inner_text("body")[:400000] + " " + (page.title() or "")
        except Exception as e: return "err:" + type(e).__name__, ""
    page = ctx.new_page()
    try:
        if o["home_allowed"]:
            st, body = get(page, base + "/"); o["home"] = st
            o["home_wall"] = bool(re.search(r"(?i)access denied|just a moment|request could not be satisfied|are you a robot|captcha", body[:3000]))
        if r["status"] == "blocked-tos" and r.get("tos_url") and r.get("tos_q"):
            st, body = get(page, r["tos_url"]); q = norm(r["tos_q"])[:60]
            o["tos_fetch"] = st; o["tos_quote_found"] = q in norm(body) if body else None
        if r["status"] == "crawled":
            found = {}; urls = {}
            for pq in r.get("pay_q") or []:
                if pq.get("neg"): continue
                urls.setdefault(pq["url"], []).append(pq)
            for u, pqs in list(urls.items())[:3]:
                st, body = get(page, u); nb = norm(body)
                for pq in pqs:
                    q = norm(pq["q"]); found.setdefault(pq["c"], False)
                    if body and (q[:60] in nb or q[-60:] in nb): found[pq["c"]] = True
            o["pay_quotes"] = found
    finally: page.close()
    return o

def main(out=os.path.join(HERE, "out", "spotcheck-2026-10-29.jsonl")):
    recs = [json.loads(l) for l in open(os.path.join(HERE, "out", "records.final.jsonl")) if l.strip()]
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw, open(out, "w") as f:
        b = pw.chromium.launch(headless=True); ctx = b.new_context(user_agent=UA)
        for r in sample(recs):
            o = check(ctx, r); f.write(json.dumps(o) + "\n"); f.flush(); print(json.dumps(o)[:300])
        b.close()
if __name__ == "__main__": main(*sys.argv[1:])
