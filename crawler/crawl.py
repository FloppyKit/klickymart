#!/usr/bin/env python3
"""FloppyKitMapBot crawler. Policy: honest UA, robots.txt honored, no login, no orders,
no captcha solving, no stealth, stop at walls and record them (rubric v0.2 `ar`).
Usage: python crawl.py sites.json [--out out] [--batch 25] [--offset 0] [--force] [--only d1,d2]
--force ignores the resume cache (domains already in records.jsonl) and replaces their records.
--only restricts the run to the named domains (applied before --offset/--batch)."""
import json, re, sys, time, hashlib, argparse, os, urllib.robotparser
from urllib.parse import urljoin, urlparse
from playwright.sync_api import sync_playwright
from extract import extract_payments, scope_split

UA = "FloppyKitMapBot/0.2 (+https://klickymart.com/bot; bot@klickymart.com)"   # bot info + opt-out page (site/bot/index.html)
UA_TOKEN = "FloppyKitMapBot"
AI_UAS = ["GPTBot","ChatGPT-User","OAI-SearchBot","ClaudeBot","Claude-User","anthropic-ai","PerplexityBot",
          "Google-Extended","CCBot","Grok","Grok-User","Applebot-Extended","Bytespider","Amazonbot"]
PACE = 3.0          # seconds between requests to one site
MAX_PAGES = 6       # per site
NAV_TIMEOUT = 30000
HELP_RX = re.compile(r"(?i)\b(payment|ways to pay|pay(ing)? with|accepted|bitcoin|crypto|lightning|faq|help)\b")
WALL_TITLES = [("cf", r"(?i)just a moment|attention required|cloudflare"),
               ("ak", r"(?i)^access denied$"),
               ("px", r"(?i)robot or human|press & hold|px-captcha"),
               ("cap!", r"(?i)captcha|are you a robot|verify you are human|robot check")]

def now(): return int(time.time())

UGC_SEL = ("[itemprop=review],[itemtype*='schema.org/Review'],[data-testid*=review i],[id*=review i],"
           "[class*=review i]:not([class*=preview i]),[class*=testimonial i],[class*=trustpilot i],[id*=comments i],"
           "[class*=comment i],[class*=question-answer i],[class*=questions-answers i],[id*=questions i][id*=answers i],[data-hook*=review i],[class*=yotpo i],[class*=judgeme i],[class*=bazaarvoice i],[id*=bazaarvoice i]")
MARK_JS = """() => { const sel = %s; const els = [...document.querySelectorAll(sel)];
  const top = els.filter(e => !els.some(o => o !== e && o.contains(e)));
  for (const e of top) { if (!e.parentNode || e === document.body) continue;
    const a = document.createElement('div'); a.textContent = '[ugc-start]';
    const b = document.createElement('div'); b.textContent = '[ugc-end]';
    e.parentNode.insertBefore(a, e); e.parentNode.insertBefore(b, e.nextSibling); } }""" % json.dumps(UGC_SEL)
# collapsed accordions/tabs: textContent of hidden blocks, with the nearest heading/toggle emitted as a '## ' line
# so the extractor can scope items (e.g. an 'In store' accordion). UGC containers are tagged too.
HIDDEN_JS = """() => { const out = []; const ugcSel = %s;
  for (const e of document.querySelectorAll('h1,h2,h3,h4,summary,button[aria-expanded],[role=tab],li,p,dd,td')) {
    const t = e.textContent.replace(/\\s+/g,' ').trim(); if (t.length <= 3) continue;
    const isHead = /^(H[1-4]|SUMMARY|BUTTON)$/.test(e.tagName) || e.getAttribute('role') === 'tab';
    if (isHead) { if (t.length < 80) out.push('## ' + t); continue; }
    if (e.offsetParent) continue;
    if (e.closest(ugcSel)) { out.push('[ugc-start]', t, '[ugc-end]'); continue; }
    out.push(t); }
  const seen = new Set(); return out.filter(x => x.startsWith('[ugc') || x.startsWith('## ') || (!seen.has(x) && seen.add(x))); }""" % json.dumps(UGC_SEL)

def load_robots(ctx, base):
    rp = urllib.robotparser.RobotFileParser(); info = {"status": None, "ai_rules": []}
    try:
        r = ctx.request.get(base + "/robots.txt", timeout=20000, max_redirects=5)
        info["status"] = r.status; txt = r.text() if r.ok else ""
    except Exception as e:
        info["status"] = f"err:{type(e).__name__}"; txt = ""
    if info["status"] == 200:
        rp.parse(txt.splitlines())
        # named AI-agent groups that disallow "/" entirely
        groups = re.split(r"(?im)^(?=user-agent:)", txt)
        for ua in AI_UAS:
            for g in groups:
                if re.search(rf"(?im)^user-agent:\s*{re.escape(ua)}\s*$", g):
                    if re.search(r"(?im)^disallow:\s*/\s*$", g): info["ai_rules"].append(ua+":/")
                    elif re.search(r"(?im)^disallow:\s*\S", g): info["ai_rules"].append(ua+":partial")
        info["raw_sha"] = hashlib.sha256(txt.encode()).hexdigest()
    elif isinstance(info["status"], int) and 400 <= info["status"] < 500 and info["status"] not in (401, 403):
        rp.parse([])            # no robots = allowed
    else:
        rp.parse(["User-agent: *", "Disallow: /"])   # 401/403/5xx/error: treat as disallow (conservative)
    return rp, info

def detect_wall(page, status, title, html):
    for code, rx in WALL_TITLES:
        if re.search(rx, title or ""): return code
    if status in (403, 429, 503):
        if "cf-chl" in html or "challenge-platform" in html: return "cf"
        if "edgesuite.net" in html or "Reference&#32;&#35;" in html: return "ak"
        return str(status)
    # visible captcha widgets (not just a script tag)
    try: body_len = len(page.inner_text("body"))
    except Exception: body_len = 0
    for sel, code in [("iframe[src*='recaptcha'][src*='anchor']","cap!" if body_len < 600 else None),("iframe[src*='hcaptcha']","cap!"),
                      ("iframe[src*='challenges.cloudflare.com']","cf"),("#px-captcha","px")]:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible() and code: return code
        except Exception: pass
    return None

def passive_flags(html):
    f = []
    if re.search(r"(?i)perimeterx|px-cdn|px-cloud", html): f.append("px")
    if re.search(r"(?i)recaptcha|hcaptcha|turnstile|CAPTCHA_ENABLED", html): f.append("cap")
    return f

def visit(ctx, site, url, step, ev_dir, rec):
    page = ctx.new_page(); res = {"url": url, "step": step}
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
        try: page.wait_for_load_state("networkidle", timeout=8000)
        except Exception: pass
        status = resp.status if resp else None
        title = page.title(); html = page.content()
        res.update(status=status, title=title[:120], final=page.url)
        wall = detect_wall(page, status, title, html)
        if wall:
            shot = f"{ev_dir}/{site['d']}_{step}.png"; page.screenshot(path=shot, full_page=False)
            rec["ar"].append({"c": wall, "at": step, "ev": url, "n": f"HTTP {status}; title '{title[:60]}'",
                              "shot": os.path.basename(shot), "shot_sha": hashlib.sha256(open(shot,'rb').read()).hexdigest()})
            res["wall"] = wall; return res, None, None
        for fl in passive_flags(html):
            if not any(a["c"] == fl for a in rec["ar"]):
                rec["ar"].append({"c": fl, "at": step, "ev": url, "n": "script/flag present; not served"})
        page.evaluate(MARK_JS)   # local DOM annotation only: wraps review/Q&A/comment blocks in [ugc-start]/[ugc-end] lines
        text = page.inner_text("body")[:400000]
        # collapsed accordions/tabs: include textContent of block elements (marked) so FAQ answers are readable
        hidden = page.evaluate(HIDDEN_JS)
        if hidden: text += "\n[collapsed]\n" + "\n".join(dict.fromkeys(hidden))
        os.makedirs(os.path.join(os.path.dirname(ev_dir), "text"), exist_ok=True)
        open(os.path.join(os.path.dirname(ev_dir), "text", f"{site['d']}_{step}_{hashlib.sha1(url.encode()).hexdigest()[:8]}.txt"), "w").write(url + "\n" + title + "\n\n" + text)
        res["chars"] = len(text)
        links = [(a.get("text") or "", a.get("href")) for a in page.eval_on_selector_all(
            "a[href]", "els=>els.map(e=>({text:e.innerText.trim().slice(0,80),href:e.href}))")]
        if len(text.strip()) < 200 and step in ("help", "pdp"):
            rec["ar"].append({"c": "js", "at": step, "ev": url, "n": "rendered text <200 chars"})
        return res, text, links
    except Exception as e:
        res.update(error=type(e).__name__, msg=str(e)[:160])
        if "Timeout" in type(e).__name__ or "ERR_" in str(e):
            rec["ar"].append({"c": "tarpit" if "Timeout" in type(e).__name__ else "net", "at": step, "ev": url, "n": str(e)[:100]})
        return res, None, None
    finally:
        page.close()

VANTAGE = {"ip": "single-datacenter", "n": "all requests from one cloud/datacenter IP (shared box); no proxies or rotation"}

def tos_blocked_record(site, t):
    """Matt's rule (2026-10-29): terms ban automation -> no crawl at all; record the finding with quote + URL."""
    return {"d": site["d"], "cat": site.get("cat", []), "v": "0.3-draft", "ts": now(), "ua": UA, "status": "blocked-tos",
            "ar": [{"c": "tos", "at": "tos", "ev": t["url"], "n": t["q"][:200]}], "fetch": {"tos": "bans-automation"},
            "tos": "bans-automation", "tos_q": t["q"], "tos_q_lead": t.get("q_lead"), "tos_url": t["url"], "ag": None, "co": None, "pay": [], "pay_no": [],
            "pay_q": [], "pay_online": [], "pay_instore": [], "pay_unscoped": [], "pay_src": None, "evu": [t["url"]],
            "btc": None, "btc_any": None, "kyc": None, "steps": None, "guest": None, "vantage": VANTAGE}

def load_tos(path):
    m = {}
    if os.path.exists(path):
        for l in open(path):
            if l.strip(): r = json.loads(l); m[r["d"]] = r
    return m

def crawl_site(browser, site, ev_dir, tos=None):
    if tos and tos.get("tos") == "bans-automation" and tos.get("q") and tos.get("url"):
        return tos_blocked_record(site, tos)
    d = site["d"]; base = site.get("base", f"https://{'' if d.count('.')>1 else 'www.'}{d}")
    rec = {"d": d, "cat": site.get("cat", []), "v": "0.3-draft", "ts": now(), "ua": UA, "vantage": VANTAGE, "ar": [], "fetch": {},
           "pay": [], "pay_no": [], "pay_q": [], "pay_src": None, "evu": []}
    ctx = browser.new_context(user_agent=UA, locale="en-US", viewport={"width": 1280, "height": 900})
    rp, rinfo = load_robots(ctx, base)
    rec["fetch"]["robots"] = rinfo["status"]
    rs = rinfo["status"]
    if rs != 200 and not (isinstance(rs, int) and 400 <= rs < 500 and rs not in (401, 403)):
        rec["ar"].append({"c": "tarpit" if "Timeout" in str(rs) else ("403" if rs == 403 else "net"), "at": "robots",
                          "ev": base + "/robots.txt", "n": f"robots.txt -> {rs}; treated as Disallow: / (conservative), site not crawled"})
    if rinfo["ai_rules"]:
        rec["ar"].append({"c": "rb_ai", "at": "robots", "ev": base + "/robots.txt", "n": ", ".join(rinfo["ai_rules"])[:200]})
    for p in ("/cart", "/checkout"):
        if not rp.can_fetch(UA_TOKEN, base + p) and rp.can_fetch(UA_TOKEN, base + "/"):
            rec["ar"].append({"c": "rb_ck", "at": "robots", "ev": base + "/robots.txt", "n": f"Disallow {p} for our UA"}); break
    texts = []; pages = 0
    plan = [("home", base + "/")] + [("pdp", u) for u in site.get("pdp", [])] + \
           [("help", u) for u in site.get("help", [])] + [("cart", u) for u in site.get("cart", [])]
    seen = set(); discovered = False
    while plan and pages < MAX_PAGES:
        step, url = plan.pop(0)
        if url in seen: continue
        seen.add(url)
        if not rp.can_fetch(UA_TOKEN, url):
            rec["fetch"][step] = "skip:robots"; continue
        time.sleep(PACE); pages += 1
        res, text, links = visit(ctx, site, url, step, ev_dir, rec)
        rec["fetch"][step if step not in rec["fetch"] else f"{step}{pages}"] = res.get("wall") or res.get("status") or res.get("error")
        if res.get("wall"):
            if step == "home": break
            continue
        if text:
            texts.append((url, step, res.get("title", ""), text))
            if step == "home" and not site.get("help") and links and not discovered:
                discovered = True
                cands = [h for t, h in links if h and urlparse(h).netloc.endswith(d.split("/")[0]) and HELP_RX.search(t + " " + h)]
                for h in cands[:2]: plan.append(("help", h))
    ctx.close()
    uniq = []
    for x in rec["ar"]:
        if not any(u["c"] == x["c"] and u["at"] == x["at"] for u in uniq): uniq.append(x)
    rec["ar"] = uniq
    # extraction
    pay, pay_no, quotes = extract_payments(texts)
    rec["pay"], rec["pay_no"], rec["pay_q"] = pay, pay_no, quotes
    rec["pay_online"], rec["pay_instore"], rec["pay_unscoped"] = scope_split(quotes)
    rec["pay_src"] = "observed-rendered-pages" if pay else None
    rec["evu"] = sorted({q["url"] for q in quotes})
    rec["kyc"] = None; rec["co"] = None; rec["steps"] = None; rec["guest"] = None; rec["tos"] = (tos or {}).get("tos")   # 'ok' or null (unknown); bans-automation never reaches here
    if tos and tos.get("url"): rec["tos_url"] = tos["url"]
    home = rec["fetch"].get("home")
    hard = {"cf","ak","px","cap!","403","429","503","tarpit","net"}
    if home in hard or (isinstance(home, str) and home.startswith("err")) or home is None or home == "skip:robots":
        rec["ag"] = 0
    else:
        other = [v for k, v in rec["fetch"].items() if k not in ("robots", "home")]
        rec["ag"] = 2 if any(v == 200 for v in other) else 1
    btcish = [p for p in pay if p in ("btc", "ln", "liq", "cashu", "fedi", "ark", "sp", "bolt12", "lnurl")]
    rec["btc_any"] = bool(btcish)
    rec["btc"] = (0 if (rec["ag"] >= 1 and not btcish and pay) else None)   # grade >=1 needs processor evidence: human/QA step
    rec["btc_conf"] = "low"
    rec["conf"] = "low" if len(quotes) < 2 else "med"
    return rec

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("sites"); ap.add_argument("--out", default="out")
    ap.add_argument("--batch", type=int, default=25); ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--force", action="store_true"); ap.add_argument("--only", default="")
    ap.add_argument("--tos", default=None, help="tos.jsonl from tos.py (default out/tos.jsonl)")
    ap.add_argument("--require-tos", action="store_true", help="refuse to crawl a site with no ToS check on file")
    a = ap.parse_args()
    sites = json.load(open(a.sites)); os.makedirs(a.out + "/evidence", exist_ok=True)
    if a.only:
        want = {x.strip() for x in a.only.split(",") if x.strip()}
        missing = want - {s["d"] for s in sites}
        if missing: sys.exit(f"--only: not in {a.sites}: {sorted(missing)}")
        sites = [s for s in sites if s["d"] in want]
    outp = a.out + "/records.jsonl"
    done = set()
    if os.path.exists(outp) and not a.force:
        done = {json.loads(l)["d"] for l in open(outp) if l.strip()}
    todo = [s for s in sites[a.offset:a.offset + a.batch] if s["d"] not in done]
    log = open(a.out + "/crawl.log", "a")
    tosmap = load_tos(a.tos or os.path.join(a.out, "tos.jsonl"))
    if a.require_tos:
        miss = [s["d"] for s in todo if s["d"] not in tosmap]
        if miss: sys.exit(f"--require-tos: no tos.jsonl entry for {miss}; run tos.py first")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)   # no stealth args, no fingerprint changes
        for s in todo:
            t0 = time.time()
            try: rec = crawl_site(browser, s, a.out + "/evidence", tosmap.get(s["d"]))
            except Exception as e:
                rec = {"d": s["d"], "v": "0.2", "ts": now(), "ag": None, "err": str(e)[:200], "ar": []}
            with open(outp, "a") as f: f.write(json.dumps(rec, separators=(",", ":")) + "\n")
            line = f"{s['d']}: status={rec.get('status','crawled')} ag={rec.get('ag')} ar={[x['c'] for x in rec['ar']]} pay={rec.get('pay')} fetch={rec.get('fetch')} {time.time()-t0:.0f}s"
            print(line, flush=True); log.write(line + "\n"); log.flush()
        browser.close()
    # dedupe: last record per domain wins (makes --force re-runs idempotent)
    recs = {}
    for l in open(outp):
        if l.strip(): r = json.loads(l); recs[r["d"]] = r
    with open(outp, "w") as f:
        for r in recs.values(): f.write(json.dumps(r, separators=(",", ":")) + "\n")

if __name__ == "__main__": main()
