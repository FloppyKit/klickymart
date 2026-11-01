#!/usr/bin/env python3
"""Round-2 ask: structured shipping policies from each store's own public shipping page.
Robots first (error/403/timeout = disallow), honest UA, <=6 requests/store, 2 s pacing (offers.Site). Skips stores whose
terms ban automation. A small model turns the page text into rules, and every rule must quote the page verbatim
(checked here); rules without a verbatim quote are dropped. Output: out/ship_policy.jsonl. Never guesses."""
import json, re, sys, time, datetime, urllib.robotparser, concurrent.futures as cf
from urllib.parse import urljoin, urlparse
from offers import Site
from ship import SHIP_PATHS, text_of
import llm
iso = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
MODEL = "anthropic/claude-haiku-5.5"
PROMPT = """You read a store's shipping-policy page text and return JSON only:
{"ships_us": true|false|null, "rules": [{"type": "free"|"free_over"|"flat"|"per_region"|"calculated", "usd": number|null, "min_usd": number|null,
 "region": "US"|"contiguous-US"|"AK-HI"|"intl"|"<state codes comma-separated>"|null, "method": "standard"|"ground"|"economy"|"expedited"|null,
 "quote": "<exact sentence copied from the text that states this rule>"}]}
Rules: only US-relevant rules for the cheapest standard method. "free" = shipping always free; "free_over" = free when the order subtotal is >= min_usd;
"flat" = a fixed price usd; "per_region" = a fixed usd for a named region; "calculated" = rate computed at checkout (no number).
Copy quotes character-for-character. If the page states nothing concrete, return {"ships_us": null, "rules": []}. Never infer numbers."""
norm = lambda s: re.sub(r"\s+", " ", s or "").strip().lower()
LINK = re.compile(r'href="([^"#]*(?:shipping|delivery|ship-)[^"#]*)"', re.I)

def run(d, base):
    s = Site(d, base); res = {"d": d, "checked_at": iso(), "rules": [], "src": None}
    st, rb = s.get(base.rstrip("/") + "/robots.txt")
    if st not in (200, 404): res["skip"] = f"robots {st} (treated as disallow)"; return res
    s.rp = urllib.robotparser.RobotFileParser(); s.rp.parse(rb.splitlines() if st == 200 else [])
    cands = [urljoin(base, p) for p in SHIP_PATHS[:4] + ["/shipping-information", "/pages/shipping-returns", "/policies/shipping"]]
    text, src = None, None
    for u in cands:
        if s.n >= 6: break  # leave room for home-page link discovery
        if not s.rp.can_fetch("FloppyKitMapBot", u): continue
        st, h = s.get(u)
        if st == 200 and h:
            t = text_of(h)
            if re.search(r"(?i)shipping", t) and len(t) > 300: text, src = t, u; break
    if not text and s.n < 9:
        st, h = s.get(base)
        links = [urljoin(base, x) for x in LINK.findall(h or "")]
        links = [x for x in links if urlparse(x).netloc.endswith(d.removeprefix("www.")) and s.rp.can_fetch("FloppyKitMapBot", x)]
        for u in list(dict.fromkeys(links))[:2]:
            st, h = s.get(u)
            if st == 200 and h: text, src = text_of(h), u; break
    res["requests"] = s.log
    if not text: res["note"] = "no public shipping page found"; return res
    i = max(0, text.lower().find("shipping") - 500); chunk = text[i:i + 7000]
    try:
        raw = (llm.chat("ship-policy", MODEL, [{"role": "system", "content": PROMPT}, {"role": "user", "content": chunk}], max_tokens=700))
        m = re.search(r"\{.*\}", raw, re.S); out = json.loads(m.group(0) if m else raw)
    except llm.CapReached: raise
    except Exception as e: res["note"] = f"parse error {str(e)[:80]}"; return res
    nt = norm(text); kept, dropped = [], 0
    for r in out.get("rules") or []:
        q = r.get("quote") or ""
        if len(q) >= 12 and norm(q) in nt: r["quote"] = q[:300]; kept.append(r)
        else: dropped += 1
    res.update(rules=kept, ships_us=out.get("ships_us"), src=src, dropped_unquoted=dropped, method="shipping-page-text + model extraction; every rule quotes the page verbatim")
    return res

if __name__ == "__main__":
    outp = "out/ship_policy.jsonl"; args = sys.argv[1:]
    if args and args[0].startswith("--out="): outp = args[0][6:]; args = args[1:]
    only = None
    if args and args[0].startswith("--only="): only = set(args[0][7:].split(",")); args = args[1:]
    recs = [json.loads(l) for f in args for l in open(f) if l.strip()]
    if only: recs = [r for r in recs if r["d"] in only]
    todo = {}
    for r in recs:
        if r.get("status") != "crawled" or r.get("tos") == "bans-automation": continue
        todo[r["d"]] = r.get("base") or f"https://{r['d']}/"
    print(len(todo), "stores", flush=True)
    with cf.ThreadPoolExecutor(8) as ex, open(outp, "w") as f:
        for res in ex.map(lambda kv: run(*kv), todo.items()):
            f.write(json.dumps(res) + "\n"); f.flush()
            print(res["d"], len(res["rules"]), res.get("skip") or res.get("note") or "", flush=True)
    print("spent", round(llm.spent(), 4))
