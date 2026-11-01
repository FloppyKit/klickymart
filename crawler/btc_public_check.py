#!/usr/bin/env python3
"""Public-page BTC processor scan for the ungraded candidates (2026-10-29). robots first; <=6 pages/site; 3 s spacing."""
import json, re, sys, time, urllib.robotparser
from ua import UA; TOKEN = "FloppyKitMapBot"
KW = {"bitcoin": r"\bbitcoin\b|\bBTC\b", "lightning": r"lightning (network|payment|invoice)|\bLN\b|⚡", "cashu": r"\bcashu\b|ecash",
      "btcpay": r"btcpay", "opennode": r"opennode", "strike": r"\bstrike\b", "coinbase-commerce": r"coinbase commerce",
      "bitpay": r"\bbitpay\b", "zaprite": r"zaprite", "nowpayments": r"nowpayments", "coingate": r"coingate"}
PATHS = ["/", "/faq", "/pages/faq", "/help", "/payment", "/pages/payment-methods"]
def run(d):
    base = "https://" + (d if d.count(".") > 1 else "www." + d); res = {"d": d, "pages": {}}
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True); ctx = b.new_context(user_agent=UA); rp = urllib.robotparser.RobotFileParser()
        try:
            r = ctx.request.get(base + "/robots.txt", timeout=20000); res["robots"] = r.status; t = r.text() if r.ok else ""
        except Exception as e: res["robots"] = "err:" + type(e).__name__; t = None
        if res["robots"] == 200: rp.parse(t.splitlines())
        elif isinstance(res["robots"], int) and 400 <= res["robots"] < 500 and res["robots"] not in (401, 403): rp.parse([])
        else: res["skip"] = "robots error/403 => disallow"; b.close(); return res
        p = ctx.new_page()
        for path in PATHS:
            u = base + path
            if not rp.can_fetch(TOKEN, u): res["pages"][u] = "robots-disallow"; continue
            time.sleep(3)
            try:
                resp = p.goto(u, timeout=30000, wait_until="domcontentloaded"); p.wait_for_timeout(2000)
                if not resp or resp.status >= 400: res["pages"][u] = resp.status if resp else None; continue
                txt = p.inner_text("body") + " " + p.content()[:300000]
                hits = {}
                for k, rx in KW.items():
                    m = re.search(rx, txt, re.I)
                    if m:
                        s = p.inner_text("body"); mm = re.search(rx, s, re.I)
                        hits[k] = re.sub(r"\s+", " ", s[max(0, mm.start()-90):mm.end()+90]) if mm else "(html/source only)"
                res["pages"][p.url] = hits
            except Exception as e: res["pages"][u] = "err:" + type(e).__name__
        b.close()
    return res
if __name__ == "__main__":
    for d in sys.argv[1].split(","): print(json.dumps(run(d)), flush=True)
