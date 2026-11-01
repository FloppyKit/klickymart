"""GO D5 second pass for sites whose policy links are rendered by JavaScript: Playwright (honest UA, no stealth) renders the home page,
reads footer links matching return/refund/price-match, opens <=3 (robots-checked, 2 s apart), then the same LLM + quote validator as policies.py."""
import json, re, sys, time, urllib.robotparser, urllib.request
from playwright.sync_api import sync_playwright
from ua import UA, UA_TOKEN
import policies, llm
LINK = re.compile(r"return|refund|exchange|price[- ]?(match|adjust|guarantee|protection)", re.I)
def robots(base):
    try:
        t = urllib.request.urlopen(urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA}), timeout=20).read().decode("utf-8", "replace")
        rp = urllib.robotparser.RobotFileParser(); rp.parse(t.splitlines()); return rp
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500 and e.code not in (401, 403, 429): rp = urllib.robotparser.RobotFileParser(); rp.parse([]); return rp
        return None
    except Exception: return None
def run(page, d):
    base = "https://" + ("" if d.count(".") > 1 else "www.") + d
    res = {"domain": d, "checked_at": policies.iso(), "src": [], "why": None, "pass": "playwright"}
    rp = robots(base)
    if rp is None or not rp.can_fetch(UA_TOKEN, base + "/"): res["why"] = "robots"; return res
    try:
        page.goto(base + "/", timeout=45000, wait_until="domcontentloaded"); time.sleep(2)
        links = page.eval_on_selector_all("a[href]", "els=>els.map(e=>({t:(e.innerText||'').trim().slice(0,60),h:e.href}))")
    except Exception as e: res["why"] = "home-" + type(e).__name__; return res
    apex = ".".join(d.split(".")[-2:])
    netloc = lambda h: h.split("/")[2].split(":")[0] if h.startswith("http") and h.count("/") >= 2 else ""
    cands = [l["h"] for l in links if (LINK.search(l["t"]) or LINK.search(l["h"])) and (netloc(l["h"]) == apex or netloc(l["h"]).endswith("." + apex))]
    cands = list(dict.fromkeys(cands)); cands.sort(key=lambda u: 0 if re.search(r"return|refund", u, re.I) else 1)
    texts = []
    for u in cands[:3]:
        nb = "https://" + netloc(u)
        rpu = rp if netloc(u).removeprefix("www.") == d.removeprefix("www.") else robots(nb)
        if rpu is None or not rpu.can_fetch(UA_TOKEN, u): continue
        try:
            time.sleep(2); page.goto(u, timeout=45000, wait_until="domcontentloaded"); time.sleep(2)
            t = page.inner_text("body")
            if len(t) > 300 and re.search(r"return|refund", t, re.I): texts.append((u, t)); res["src"].append(u)
        except Exception: continue
    if not texts: res["why"] = "no-policy-page"; return res
    full = "\n\n".join(f"[{u}]\n{t[:9000]}" for u, t in texts)
    try:
        raw = llm.chat("D5", policies.MODEL, [{"role": "user", "content": policies.PROMPT % (d, full)}], max_tokens=1200)
        j = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except Exception as e: res["why"] = "llm-error:" + type(e).__name__; return res
    ok, bad = policies.validate(j, full)
    res.update(ok); res["rejected_fields"] = bad; res["method"] = "llm:" + policies.MODEL + "+quote-substring-check (playwright-rendered)"
    res["field_src"] = {f: next((u for u, t in texts if policies.norm(q) in policies.norm(t)), None) for f, q in (ok.get("quotes") or {}).items()}
    return res
if __name__ == "__main__":
    doms = open(sys.argv[1]).read().split()
    with sync_playwright() as pw, open(sys.argv[2], "w") as f:
        b = pw.chromium.launch(headless=True); ctx = b.new_context(user_agent=UA, locale="en-US"); page = ctx.new_page()
        for d in doms:
            r = run(page, d); f.write(json.dumps(r) + "\n"); f.flush(); print(d, r.get("return_days"), r.get("why"), flush=True)
        b.close()
