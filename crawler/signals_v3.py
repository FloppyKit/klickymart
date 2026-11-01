#!/usr/bin/env python3
"""Public-page signals for v3 records (no browser, no forms): payment methods (incl. Lightning), guest-checkout statements,
free-shipping threshold, ships-to-US. Robots first (error/403 = disallow), honest UA, <=6 pages/site, 3 s pacing.
Usage: signals_v3.py records.jsonl|events.jsonl out.jsonl [--only a,b]"""
import html as H, json, re, sys, time, urllib.request, urllib.robotparser, concurrent.futures as cf
from urllib.parse import urljoin, urlparse
from extract import extract_payments
from ua import UA; TOKEN = "FloppyKitMapBot"
PACE, MAXP = 3.0, 6
LINK_RX = re.compile(r"(?i)payment|pay-?with|ways-to-pay|faq|help|shipping|delivery|guest|checkout|order(ing)?-?(info|help)|customer-?service|bitcoin|crypto|lightning")
GUEST_YES = re.compile(r"(?i)\b(check ?out|order|purchase|shop|buy)\w*\b[^.]{0,40}\bas a guest\b|\bguest check ?out\b(?![^.]{0,30}\b(is )?(not|no longer|unavailable))|\bcontinue as (a )?guest\b|\bwithout (creating |having |signing up for |registering )?(an |a )?(account|registration)\b|\bno (account|registration|sign-?up) (is )?(needed|required|necessary)\b")
GUEST_NO = re.compile(r"(?i)\b(must|need to|required to|have to)\b[^.]{0,20}\b(create|have|sign in|log in|register)\b[^.]{0,30}\baccount\b[^.]{0,30}\b(to|before|in order to)\b[^.]{0,15}\b(order|purchase|check ?out|buy)|guest check ?out is (not|no longer) (available|supported|offered)|account is required to (order|purchase|check ?out)")
FREE_SHIP = re.compile(r"(?i)\bfree (standard |ground |economy )?(shipping|delivery)\b[^.$]{0,40}?\b(on |for )?(all )?(orders?|purchases?)?\s*(of |over |above |at least |\$)?\s*\$\s?(\d{1,4}(?:\.\d\d)?)\+?|\borders? (of |over |above )?\$\s?(\d{1,4}(?:\.\d\d)?)\+? (ship|get free (standard )?shipping)\b")
SHIPS_US = re.compile(r"(?i)\b(ship|deliver)\w*\b[^.]{0,30}\b(to|within|throughout|across) (all 50 states|the (contiguous |continental )?(united states|u\.?s\.?a?\.?)|usa\b|the us\b)")
NO_US = re.compile(r"(?i)\b(do not|don't|cannot|can't|unable to)\b[^.]{0,20}\b(ship|deliver)\w*\b[^.]{0,20}\b(to )?the (united states|us|usa)\b")

def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.8", "Accept": "text/html,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.geturl(), r.read(1_500_000).decode(r.headers.get_content_charset() or "utf-8", "replace")

def text_of(html):
    t = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html)
    t = re.sub(r"(?i)<(br|/p|/li|/tr|/h\d|/div|/td|/dt|/dd)[^>]*>", "\n", t)
    t = re.sub(r"(?i)<(td|th)[^>]*>", " ", t)
    t = H.unescape(re.sub(r"<[^>]+>", " ", t))
    return "\n".join(re.sub(r"[ \t\r\f\v]+", " ", l).strip() for l in t.splitlines() if l.strip())

def title_of(html):
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", html); return H.unescape(m.group(1)).strip()[:200] if m else ""

def first(rx, text, url, grp=None):
    for line in text.splitlines():
        if len(line) > 600: continue
        m = rx.search(line)
        if m: return {"q": line[:240], "url": url, **({"m": m} if grp else {})}
    return None

def site(rec):
    d = rec["d"]; base = "https://" + (d if d.count(".") > 1 else "www." + d)
    out = {"d": d, "ts": int(time.time()), "pages": [], "robots": None}
    try:
        st, _, txt = fetch(base + "/robots.txt"); out["robots"] = st
    except urllib.error.HTTPError as e:
        out["robots"] = e.code
        if e.code in (401, 403) or e.code >= 500: return out   # error/403 = disallow
        txt = ""
    except Exception as e:
        out["robots"] = f"err:{type(e).__name__}"; return out
    rp = urllib.robotparser.RobotFileParser(); rp.parse(txt.splitlines())
    queue = [base + "/"] + [u for u in rec.get("evu") or [] if u.startswith("http")]
    seen, texts, last = set(), [], 0.0
    while queue and len(out["pages"]) < MAXP:
        u = queue.pop(0)
        if u in seen or not rp.can_fetch(TOKEN, u): continue
        seen.add(u); time.sleep(max(0, PACE - (time.time() - last))); last = time.time()
        try: st, fin, html = fetch(u)
        except urllib.error.HTTPError as e: out["pages"].append([u, e.code]); continue
        except Exception as e: out["pages"].append([u, type(e).__name__]); continue
        out["pages"].append([fin, st])
        t, ti = text_of(html), title_of(html)
        step = "home" if len(out["pages"]) == 1 else "help"
        texts.append((fin, step, ti, t))
        if step == "home":
            links = re.findall(r'(?i)href="([^"#]+)"', html)
            host = urlparse(fin).netloc.split(":")[0]; root = ".".join(host.split(".")[-2:])
            cand = []
            for h in links:
                a = urljoin(fin, H.unescape(h)); pu = urlparse(a)
                if pu.scheme.startswith("http") and pu.netloc.endswith(root) and LINK_RX.search(pu.path) and a not in cand: cand.append(a)
            cand.sort(key=lambda a: (0 if re.search(r"(?i)pay|bitcoin|crypto|lightning", a) else 1 if re.search(r"(?i)ship|deliver", a) else 2 if re.search(r"(?i)guest|checkout|faq", a) else 3, len(a)))
            queue += cand[:8]
    pay, no, q = extract_payments(texts)
    out.update(pay=pay, pay_no=no, pay_q=q)
    for k, rx in (("guest_yes", GUEST_YES), ("guest_no", GUEST_NO), ("ships_us", SHIPS_US), ("no_us", NO_US)):
        for url, _, _, t in texts:
            h = first(rx, t, url)
            if h: out[k] = h; break
    for url, _, _, t in texts:
        h = first(FREE_SHIP, t, url, grp=True)
        if h:
            m = h.pop("m"); amt = m.group(7) or m.group(9)
            if amt: out["free_ship"] = dict(h, usd=float(amt)); break
    return out

def main():
    src, dst = sys.argv[1], sys.argv[2]
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
    recs = []
    for l in open(src):
        if not l.strip(): continue
        j = json.loads(l); r = json.loads(j["content"]) if "content" in j else j
        if r["status"] in ("crawled", "error") and (not only or r["d"] in only): recs.append(r)
    with cf.ThreadPoolExecutor(12) as ex, open(dst, "w") as f:
        for o in ex.map(site, recs):
            f.write(json.dumps(o) + "\n"); f.flush()
            print(o["d"], len(o["pages"]), o.get("pay"), "guest" if o.get("guest_yes") else "", o.get("free_ship", {}).get("usd", ""), flush=True)
if __name__ == "__main__": main()
