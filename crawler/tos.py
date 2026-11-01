#!/usr/bin/env python3
"""CASCADE GO 1.3: read each site's public terms page and classify automated-access rules.
Policy: robots.txt first (any error/401/403/5xx = disallow, nothing fetched); public pages only;
honest UA; >= 3 s between requests; <= 5 pages per site; stop at walls. No login, no forms.
Output (out/tos.jsonl), one line per domain:
  {"d", "tos": "ok" | "bans-automation" | null, "q": exact quote | null, "url": terms URL | null,
   "conf", "n": note, "fetch": {...}, "ts"}
 - bans-automation: a sentence on the terms page prohibits robots/spiders/scrapers/automated access (quote + URL).
 - ok: a terms page was read in full and no such sentence matched (regex; conf low, hand spot-check per GO 1.3).
 - null: no terms page found, robots disallowed it, or it was walled. Unknown stays null.
Matt's rule (2026-10-29): bans-automation => the crawler SKIPS the site entirely and records the ToS finding.
Usage: python tos.py sites.json [--only d1,d2] [--out out]"""
import json, re, sys, time, argparse, os
from terms_page import is_terms_page
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from crawl import UA, UA_TOKEN, load_robots, detect_wall, now

TEXT_DIR = "out/tos_text"; PACE = 3.0; MAX_PAGES = 5; NAV_TIMEOUT = 30000
TERMS_LINK = re.compile(r"(?i)\b(terms (of|and) (use|service|sale)|terms & conditions|terms and conditions|conditions of (use|sale)|terms|legal|user agreement)\b")
TERMS_PATHS = ["/terms", "/terms-of-service", "/policies/terms-of-service", "/terms-of-use"]
BOT = r"(robots?|spiders?|scrapers?|scrap(e|es|ing)|crawl(ers?|ing)?|data[- ]mining|automated (means|systems?|software|tools?|scripts?|process(es)?|access|devices?|equipment|queries|methods?|use)|bots?|harvest(ing)?|screen[- ]scrap\w*|agentic commerce tools?|autonomous agents?|ai agents?)"
PROHIB = r"(agree not to|you (will|shall|may|must) not|may not|must not|shall not|will not|not permitted|prohibited|forbidden|unauthorized|not authorized|without (our|the) (prior )?(express )?(written )?(consent|permission))"
BOT_RX = re.compile(rf"(?i)\b{BOT}\b"); PROHIB_RX = re.compile(rf"(?i)\b{PROHIB}\b")
DEFN = re.compile(r"(?i)(\"[^\"]{1,40}\"|“[^”]{1,40}”)\s+(means|refers to|includes)\b|\bmeans any\b")
LOOKBACK = 2500   # list-style clauses: "You agree not to: (a) ...; (f) use any robot, spider ..."

def classify(text):
    """Return (code, quote, lead). bans-automation when a robot/scraper/automation term sits in a clause governed by a
    prohibition earlier in the same paragraph (within LOOKBACK chars) or the same sentence. Quotes are exact substrings:
    `quote` = the clause naming the automation, `lead` = the prohibition sentence it falls under (None if same clause)."""
    for para in re.split(r"\n+", text):
        p = re.sub(r"[ \t]+", " ", para).strip()
        if len(p) < 20: continue
        for m in BOT_RX.finditer(p):
            cs = max(p.rfind(x, 0, m.start()) for x in (". ", "; ", ": ")) + 2
            cs = 0 if cs < 2 else cs
            ce = min([i for i in (p.find(". ", m.end()), p.find("; ", m.end())) if i != -1] + [len(p)])
            clause = p[cs:ce + 1].strip()
            if DEFN.search(clause): continue
            if PROHIB_RX.search(clause): return "bans-automation", clause[:600], None
            back = p[max(0, m.start() - LOOKBACK):cs]
            pm = list(PROHIB_RX.finditer(back))
            if pm:
                ls = back.rfind(". ", 0, pm[-1].start()); ls = 0 if ls == -1 else ls + 2
                le = back.find(":", pm[-1].end()); le = (le + 1) if le != -1 and le - pm[-1].end() < 200 else min(len(back), pm[-1].end() + 200)
                return "bans-automation", clause[:600], back[ls:le].strip()[:300]
    return "ok", None, None

def check_site(browser, site):
    d = site["d"]; base = site.get("base", f"https://{'' if d.count('.')>1 else 'www.'}{d}")
    out = {"d": d, "tos": None, "q": None, "url": None, "conf": None, "n": None, "fetch": {}, "ts": now(), "ua": UA}
    ctx = browser.new_context(user_agent=UA, locale="en-US")
    try:
        rp, info = load_robots(ctx, base); out["fetch"]["robots"] = info["status"]
        if info["status"] != 200 and not (isinstance(info["status"], int) and 400 <= info["status"] < 500 and info["status"] not in (401, 403)):
            out["n"] = f"robots.txt -> {info['status']}; treated as disallow, nothing fetched"; return out
        plan = [("home", base + "/")] + [("terms", u) for u in site.get("terms", [])]
        pages = 0; tried = set(); found_link = False
        while plan and pages < MAX_PAGES:
            step, url = plan.pop(0)
            if url in tried: continue
            tried.add(url)
            if not rp.can_fetch(UA_TOKEN, url): out["fetch"][url] = "skip:robots"; continue
            time.sleep(PACE); pages += 1
            page = ctx.new_page()
            try:
                resp = page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
                try: page.wait_for_load_state("networkidle", timeout=8000)
                except Exception: pass
                st = resp.status if resp else None; title = page.title(); html = page.content()
                wall = detect_wall(page, st, title, html)
                out["fetch"][url] = wall or st
                if wall or not st or st >= 400:
                    if step == "home": out["n"] = f"home {wall or st}; terms not reachable"; plan = [p for p in plan if p[0] == "terms"]
                    elif wall or st in (401, 403, 429): out["n"] = f"terms page {url} -> {wall or st}; not read (unknown)"
                    continue
                if step == "home":
                    links = page.eval_on_selector_all("a[href]", "els=>els.map(e=>({t:e.innerText.trim().slice(0,80),h:e.href}))")
                    host = urlparse(base).netloc.split(":")[0]; reg = ".".join(host.split(".")[-2:])
                    cands = [l["h"] for l in links if l["h"] and TERMS_LINK.search(l["t"] or "") and urlparse(l["h"]).netloc.endswith(reg)
                             and not re.search(r"(?i)privacy|cookie|accessib", (l["t"] or "") + l["h"])]
                    strong = [h for h in cands if re.search(r"(?i)terms|conditions|legal|agreement|cou\b|_cou", h)]
                    cands = list(dict.fromkeys(strong or cands))[:2]
                    found_link = bool(cands)
                    plan += [("terms", h) for h in cands] + [("terms", base + p) for p in TERMS_PATHS]  # 2026-10-31: standard paths also tried when a footer link is not a terms page
                    continue
                text = page.inner_text("body")
                try: h1 = page.inner_text("h1", timeout=2000)
                except Exception: h1 = ""
                ok_terms, why = is_terms_page(page.url, title, h1, text)
                if not ok_terms:
                    out["fetch"][url] = f"{st}:not-terms ({why})"; continue   # e.g. a region picker
                os.makedirs(TEXT_DIR, exist_ok=True)
                with open(os.path.join(TEXT_DIR, f"{d}.txt"), "w") as f: f.write(page.url + "\n" + title + "\n\n" + text)
                code, q, lead = classify(text)
                out.update(tos=code, q=q, q_lead=lead, url=page.url, conf="med" if code == "bans-automation" else "low",
                           n="regex match on terms page" if q else "terms page read; no automation clause matched (regex; needs spot-check)")
                if code == "bans-automation": return out
                plan = []   # one terms page read is enough for 'ok'
            except Exception as e:
                out["fetch"][url] = type(e).__name__
            finally:
                page.close()
        if out["tos"] is None and not out["n"]:
            out["n"] = "no terms page found within budget" + ("" if found_link else " (no terms link on home)")
        return out
    finally:
        ctx.close()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("sites"); ap.add_argument("--only", default=""); ap.add_argument("--out", default="out")
    ap.add_argument("--reclassify", action="store_true", help="offline: re-run classify() on saved out/tos_text, no network")
    a = ap.parse_args(); sites = json.load(open(a.sites))
    ov_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tos_urls.override.json")
    if os.path.exists(ov_path):   # hand-supplied terms URLs (found by search), tried before footer links
        ov = json.load(open(ov_path))
        for s in sites:
            u = (ov.get(s["d"]) or {}).get("urls") or []
            s["terms"] = list(dict.fromkeys(u + s.get("terms", [])))
    if a.reclassify:
        outp = os.path.join(a.out, "tos.jsonl"); recs = [json.loads(l) for l in open(outp) if l.strip()]
        for r in recs:
            f = os.path.join(TEXT_DIR, r["d"] + ".txt")
            if r.get("url") and os.path.exists(f):
                code, q, lead = classify(open(f).read().split("\n", 3)[3])
                r.update(tos=code, q=q, q_lead=lead, conf="med" if q else "low", ts_reclassified=now(),
                         n="regex match on terms page" if q else "terms page read; no automation clause matched (regex; needs spot-check)")
            print(f"{r['d']}: tos={r['tos']} url={r.get('url')} lead={(r.get('q_lead') or '')[:120]!r} q={(r.get('q') or '')[:200]!r}")
        with open(outp, "w") as fo:
            for r in recs: fo.write(json.dumps(r, separators=(",", ":")) + "\n")
        return
    if a.only:
        want = {x.strip() for x in a.only.split(",")}; sites = [s for s in sites if s["d"] in want]
    outp = os.path.join(a.out, "tos.jsonl"); recs = {}
    if os.path.exists(outp):
        for l in open(outp):
            if l.strip(): r = json.loads(l); recs[r["d"]] = r
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        for s in sites:
            r = check_site(b, s); recs[r["d"]] = r
            print(f"{r['d']}: tos={r['tos']} url={r['url']} n={r['n']} q={(r['q'] or '')[:160]!r}", flush=True)
            with open(outp + ".tmp", "w") as f:
                for x in recs.values(): f.write(json.dumps(x, separators=(",", ":")) + "\n")
            os.replace(outp + ".tmp", outp)   # atomic: crawl.py may read it concurrently
        b.close()

if __name__ == "__main__": main()
