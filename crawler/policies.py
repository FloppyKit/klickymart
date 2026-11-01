"""GO D5: return window, return-shipping payer, price match/adjust, restocking fee, final-sale exclusions.
<=3 policy pages per site (robots-checked, honest UA, 2 s apart) -> text -> claude-haiku-5.5 strict JSON with a verbatim quote per field.
A deterministic validator drops any field whose quote is not a substring of the fetched text. 10% audit by sonnet-5.5 (policies_audit)."""
import json, re, sys, html, time, datetime, concurrent.futures as cf, urllib.robotparser
from urllib.parse import urljoin, urlparse
from offers import Site, iso
from ua import UA_TOKEN
import llm
from policy_restrictions import analyze as restrictions_of
MODEL = "anthropic/claude-haiku-5.5"
LINK = re.compile(r"return|refund|exchange|price[- ]?(match|adjust|guarantee|protection)|shipping[- ]?(polic|info)|restock", re.I)
SHOPIFY = ["/policies/refund-policy", "/policies/shipping-policy"]
def text_of(page):
    page = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", page)
    page = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h\d|tr)>", "\n", page)
    t = html.unescape(re.sub(r"<[^>]+>", " ", page))
    return re.sub(r"[ \t\r\f\v]+", " ", re.sub(r"\n\s*\n+", "\n", t)).strip()
PROMPT = """You extract a store's deal-changing policies from its own policy page text. Return JSON only:
{"return_days": int|null, "return_days_q": str|null, "return_ship_payer": "buyer"|"seller"|"mixed"|null, "return_ship_payer_q": str|null,
 "price_match": "match"|"adjust"|"both"|"none"|null, "price_match_window_days": int|null, "price_match_q": str|null,
 "restocking_pct": number|null, "restocking_q": str|null, "exclusions": [str], "exclusions_q": str|null}
Rules: every non-null field needs its *_q: an exact, verbatim, contiguous quote (<=200 chars) copied from the text. If the text does not say it, use null.
"none" for price_match only when the text explicitly says they do not price match. return_days = the standard window for most items (not holiday extensions).
mixed = the buyer pays in some cases and the seller in others. Text from %s:
---
%s"""
FIELDS = [("return_days", "return_days_q"), ("return_ship_payer", "return_ship_payer_q"), ("price_match", "price_match_q"), ("price_match_window_days", "price_match_q"), ("restocking_pct", "restocking_q"), ("exclusions", "exclusions_q")]
def norm(s): return re.sub(r"\s+", " ", (s or "").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')).strip().lower()
def validate(j, text):
    nt = norm(text); out, bad = {}, []
    for f, q in FIELDS:
        v = j.get(f)
        if v in (None, [], ""): continue
        quote = j.get(q)
        if isinstance(quote, list): quote = quote[0] if quote else None
        if not isinstance(quote, str): quote = None
        if quote and norm(quote) in nt: out[f] = v; out.setdefault("quotes", {})[f] = quote[:200]
        else: bad.append(f)
    return out, bad
def run(rec):
    d = rec["d"]; base = rec.get("base") or ("https://" + ("" if d.count(".") > 1 else "www.") + d)
    s = Site(d, base); res = {"domain": d, "checked_at": iso(), "src": [], "why": None}
    st, txt = s.get(base + "/robots.txt")
    if st is None or st in (401, 403, 429) or (isinstance(st, int) and st >= 500): res["why"] = f"robots-{st}"; return res
    rp = urllib.robotparser.RobotFileParser(); rp.parse(txt.splitlines() if st == 200 else []); s.rp = rp
    if not rp.can_fetch(UA_TOKEN, base + "/"): res["why"] = "robots-disallow"; return res
    st, hp = s.get(base + "/")
    cands = []
    if st == 200:
        for m in re.finditer(r'<a[^>]+href="([^"#]+)"[^>]*>(.*?)</a>', hp, re.S | re.I):
            h, label = html.unescape(m.group(1)), re.sub(r"<[^>]+>", " ", m.group(2))
            u = urljoin(base + "/", h); host = (urlparse(u).hostname or "").removeprefix("www.")
            if (LINK.search(label) or LINK.search(urlparse(u).path)) and (host.endswith(d.removeprefix("www.")) ): cands.append(u)
    cands = list(dict.fromkeys(cands))
    cands.sort(key=lambda u: (0 if re.search(r"return|refund", u, re.I) else 1 if re.search(r"price", u, re.I) else 2))
    if ".myshopify" in hp or "cdn.shopify.com" in hp: cands = [base + p for p in SHOPIFY] + cands
    FALLBACK = ["/policies/refund-policy", "/pages/returns", "/returns", "/return-policy", "/help/returns", "/refund-policy", "/pages/return-policy", "/returns-policy", "/customer-service/returns", "/help/return-policy", "/shipping-returns", "/pages/shipping-returns"]
    if not cands: cands = [base + p for p in FALLBACK]
    texts = []
    for u in cands[:6]:
        if len(texts) >= 3 or s.n >= 9: break
        st, pg = s.get(u)
        if st == 200:
            t = text_of(pg)
            if len(t) > 300 and re.search(r"return|refund", t, re.I): texts.append((u, t)); res["src"].append(u)
    if not texts: res["why"] = "no-policy-page"; return res
    full = "\n\n".join(f"[{u}]\n{t[:9000]}" for u, t in texts)
    try:
        raw = llm.chat("D5", MODEL, [{"role": "user", "content": PROMPT % (d, full)}], max_tokens=1200)
        j = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except llm.CapReached: res["why"] = "llm-cap"; return res
    except Exception as e: res["why"] = "llm-error:" + type(e).__name__ + ":" + str(e)[:80]; return res
    ok, bad = validate(j, full)
    res.update(ok); res["rejected_fields"] = bad; res["method"] = "llm:" + MODEL + "+quote-substring-check"
    # src per field: first page whose text contains the quote
    res["field_src"] = {f: next((u for u, t in texts if norm(q) in norm(t)), None) for f, q in (ok.get("quotes") or {}).items()}
    # return_days is a summary: add deterministic restrictions (change-of-mind, defect window, restocking fee, final sale) and conflicting windows.
    res.update(restrictions_of(texts, ok.get("return_days")))
    return res
if __name__ == "__main__":
    recs = [json.loads(l) for l in open(sys.argv[1])]
    recs = [r for r in recs if r.get("status", "crawled") == "crawled"]
    if len(sys.argv) > 4: recs = [r for r in recs if r["d"] not in {json.loads(l)["domain"] for l in open(sys.argv[4]) if json.loads(l).get("return_days") or json.loads(l).get("price_match")}]
    if len(sys.argv) > 3 and sys.argv[3]: recs = [r for r in recs if r["d"] in set(sys.argv[3].split(","))]
    with cf.ThreadPoolExecutor(12) as ex, open(sys.argv[2], "w") as f:
        for r in ex.map(run, recs): f.write(json.dumps(r) + "\n"); f.flush(); print(r["domain"], r.get("return_days"), r.get("why"), r.get("rejected_fields"), flush=True)
