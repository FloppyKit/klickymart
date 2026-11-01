"""GO D6 (promos): merchant-published promo codes and offers from the store's own home/deals pages only (G6: no coupon sites).
<=3 pages per site, robots-checked. Regex finds candidate lines; deepseek-v4.1-flash structures them; every promo keeps a verbatim quote
that must be a substring of the fetched text. Codes are NOT entered in any cart by this script."""
import json, re, sys, html, concurrent.futures as cf, urllib.robotparser
from urllib.parse import urljoin, urlparse
from offers import Site, iso
from policies import text_of, norm
from ua import UA_TOKEN
import llm
MODEL = "deepseek/deepseek-v4.1-flash"
CAND = re.compile(r"(?i)(\bcode\b|promo|coupon|% off|\$\d+ off|free shipping|sale ends|bogo|buy one|save \d+%|save \$\d+)")
DEALS = re.compile(r"(?i)/(deals?|sale|offers?|promotions?|coupons?|specials?)(/|$|\?)")
PROMPT = """From these lines taken from {d}'s own website, list the promotions the merchant itself advertises. JSON only:
{{"promos":[{{"code":str|null,"desc":str,"min_spend":number|null,"expires":str|null,"stacking":"yes"|"no"|null,"quote":str}}]}}
quote = exact verbatim substring (<=200 chars) of the lines that states the promo. stacking = "no" only if the text says it cannot be combined.
Ignore newsletter sign-up generic copy unless it gives a code or a concrete discount. Empty list if none.
Lines:
{t}"""
def run(rec):
    d = rec["d"]; base = rec.get("base") or ("https://" + ("" if d.count(".") > 1 else "www.") + d)
    s = Site(d, base); res = {"domain": d, "checked_at": iso(), "promos": [], "src": []}
    st, txt = s.get(base + "/robots.txt")
    if st is None or st in (401, 403, 429) or (isinstance(st, int) and st >= 500): res["why"] = f"robots-{st}"; return res
    rp = urllib.robotparser.RobotFileParser(); rp.parse(txt.splitlines() if st == 200 else []); s.rp = rp
    if not rp.can_fetch(UA_TOKEN, base + "/"): res["why"] = "robots-disallow"; return res
    pages = []
    st, hp = s.get(base + "/")
    if st == 200:
        pages.append((base + "/", text_of(hp)))
        links = [urljoin(base + "/", html.unescape(h)) for h in re.findall(r'href="([^"#]+)"', hp)]
        links = [u for u in dict.fromkeys(links) if (urlparse(u).hostname or "").removeprefix("www.").endswith(d.removeprefix("www.")) and DEALS.search(urlparse(u).path)]
        for u in links[:2]:
            st, pg = s.get(u)
            if st == 200: pages.append((u, text_of(pg)))
    lines = []
    for u, t in pages:
        for l in t.split("\n"):
            l = l.strip()
            if 6 < len(l) < 300 and CAND.search(l): lines.append((u, l))
    lines = list(dict.fromkeys(lines))[:60]
    if not lines: res["why"] = "no-promo-text"; return res
    try:
        raw = llm.chat("D6", MODEL, [{"role": "user", "content": PROMPT.format(d=d, t="\n".join(l for _, l in lines))}], max_tokens=900)
        j = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except llm.CapReached: res["why"] = "llm-cap"; return res
    except Exception as e: res["why"] = "llm-error:" + type(e).__name__; return res
    for p in j.get("promos") or []:
        q = p.get("quote") or ""
        src = next((u for u, l in lines if q and norm(q) in norm(l)), None)
        if not src: continue
        p["src"] = src; p["checked_at"] = res["checked_at"]; p["method"] = "llm:" + MODEL + "+quote-substring-check"; res["promos"].append(p)
    return res
if __name__ == "__main__":
    recs = [json.loads(l) for l in open(sys.argv[1])]
    recs = [r for r in recs if r.get("status", "crawled") == "crawled" and r.get("tos") != "bans-automation"]
    with cf.ThreadPoolExecutor(12) as ex, open(sys.argv[2], "w") as f:
        for r in ex.map(run, recs): f.write(json.dumps(r) + "\n"); f.flush(); print(r["domain"], len(r["promos"]), r.get("why"), flush=True)
