"""M4 S3: store trust observations (append-only), for the S4 tiers and as info on store rows.
Signals: first_seen (our own data), domain_registered (RDAP), return_policy + contact (verbatim quotes, info only),
reseller signs (the store's own public product data; we never fetch amazon.com or target.com).
Crawler rules: only domains the S1 widen gate allows (precrawl decision "crawl"); robots.txt first on every host,
401/403/429/5xx/timeout = disallow (widen_gate.robots_decision); honest UA (ua.UA); 2-minute timeouts; >= 2 s between
requests to one host, <= 4 store requests per domain; no cart, checkout or login paths; no paid services.
RDAP: https://rdap.org/domain/<apex> (free, no key; the existing GO D7 source in crawler/trust.py and on gate.API_HOSTS),
which redirects via the IANA bootstrap to the registry's own RDAP server. The redirect is followed by hand, once, https
only, with robots.txt checked on that host too. Registry terms (e.g. Verisign's RDAP Terms of Use) forbid "high volume,
automated, electronic processes", so lookups are capped (RDAP_DAILY_CAP per run, RDAP_SPACING_S apart) and a domain with
a known registration date is never looked up again. Every fetch also passes crawler/gate.py (installed by ua.py).
Output: out/trust-obs-YYYYMMDD.jsonl and a matching .sql (INSERT OR IGNORE) that the operator applies with
`wrangler d1 execute klickymart --remote --file ...`. Row format = site/worker/src/trust-obs.ts validateObs."""
import json, re, sys, time, hashlib, datetime, html, os, urllib.request, urllib.error, urllib.robotparser, argparse
from urllib.parse import urlparse
from ua import UA, UA_TOKEN
from widen_gate import robots_decision, link_only, norm

TIMEOUT_S = 120
HOST_SPACING_S = 2.0
RDAP_DAILY_CAP = 50
RDAP_SPACING_S = 5.0
MAX_BYTES = 2_000_000
RDAP_ORG = "https://rdap.org/domain/"
SIGNALS = ("first_seen", "domain_registered", "return_policy", "contact", "reseller")
FORBIDDEN_PATH = re.compile(r"/(cart|checkout|checkouts|account|login|signin)(/|$|\?)", re.I)
TWO_LEVEL = {"co.uk", "org.uk", "com.au", "net.au", "co.nz", "co.jp", "com.br", "com.mx"}

def now_s(): return int(time.time())
def iso(ts): return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def obs_id(domain, signal, value_json):
    return hashlib.sha256(f"{domain}\0{signal}\0{value_json}".encode()).hexdigest()

def obs(domain, signal, value, method, evidence_url=None, quote=None, at=None):
    vj = json.dumps(value, sort_keys=True, separators=(",", ":"))
    q = None if quote is None else re.sub(r"\s+", " ", quote).strip()[:500]
    return {"id": obs_id(domain, signal, vj), "domain": domain, "signal": signal, "value_json": vj,
            "evidence_url": evidence_url, "quote": q, "method": method, "observed_at": at or now_s()}

def registrable(domain):
    parts = norm(domain).split(".")
    return ".".join(parts[-3:]) if ".".join(parts[-2:]) in TWO_LEVEL and len(parts) >= 3 else ".".join(parts[-2:])

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
_NO_REDIRECT = urllib.request.build_opener(_NoRedirect)

def live_fetch(url):
    """(status, text). None status = network error/timeout. Honest UA, 2-minute timeout, capped body."""
    if FORBIDDEN_PATH.search(urlparse(url).path): raise ValueError(f"refusing cart/checkout/login path: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json,application/rdap+json;q=0.9,*/*;q=0.5"})
    try:
        with _NO_REDIRECT.open(req, timeout=TIMEOUT_S) as r: return r.status, r.read(MAX_BYTES).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308): return e.code, e.headers.get("Location", "")  # caller decides whether to follow
        return e.code, ""
    except Exception: return None, ""  # timeout, network error, or gate.GateRefused

class Polite:
    """robots.txt first (cached per host), per-host spacing, request counting. fetch/sleep/clock are injectable for tests."""
    def __init__(s, fetch=live_fetch, sleep=time.sleep, clock=time.monotonic):
        s.fetch, s.sleep, s.clock, s.robots, s.last, s.log = fetch, sleep, clock, {}, {}, []
    def _wait(s, host, spacing):
        t = s.last.get(host)
        if t is not None and s.clock() - t < spacing: s.sleep(spacing - (s.clock() - t))
        s.last[host] = s.clock()
    def allowed(s, url):
        u = urlparse(url); host = u.netloc
        if host not in s.robots:
            s._wait(host, HOST_SPACING_S)
            st, body = s.fetch(f"{u.scheme}://{host}/robots.txt")
            rp = None
            if st == 200: rp = urllib.robotparser.RobotFileParser(); rp.parse(body.splitlines())
            s.robots[host] = (st, rp)
        st, rp = s.robots[host]
        ok = robots_decision(st, rp.can_fetch(UA_TOKEN, url) if rp else None) if st == 200 else robots_decision(st, None)
        if not ok: s.log.append((url, f"robots-disallow:{st}"))
        return ok
    def get(s, url, spacing=HOST_SPACING_S):
        if link_only(urlparse(url).netloc): raise ValueError(f"link-out only, never fetched: {url}")
        if FORBIDDEN_PATH.search(urlparse(url).path): raise ValueError(f"refusing cart/checkout/login path: {url}")
        if not s.allowed(url): return "robots", ""
        s._wait(urlparse(url).netloc, spacing)
        st, body = s.fetch(url); s.log.append((url, st))
        return st, body

def text_of(page):
    page = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", page)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", page))).strip()

def sentence_with(text, rx):
    for s in re.split(r"(?<=[.!?])\s+", text):
        if re.search(rx, s, re.I): return s.strip()
    return None

# ---- signals ----
def first_seen(domain, data_dir, at):
    """Earliest time OUR data saw the store (records.ndjson ts, offers.ndjson t). Never taken from the store itself."""
    best = None
    for fn, key in (("records.ndjson", "ts"), ("offers.ndjson", "t")):
        p = os.path.join(data_dir, fn)
        if not os.path.exists(p): continue
        for line in open(p):
            try: r = json.loads(line)
            except Exception: continue
            if norm(str(r.get("d", ""))) != domain: continue
            v = r.get(key)
            if isinstance(v, (int, float)) and v > 1e9: ts = int(v)
            elif isinstance(v, str):
                try: ts = int(datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp())
                except Exception: continue
            else: continue
            best = ts if best is None else min(best, ts)
    return obs(domain, "first_seen", {"at": iso(best if best is not None else at)}, "own-ledger", at=at)

def domain_registered(pol, domain, at):
    url = RDAP_ORG + registrable(domain)
    st, body = pol.get(url, spacing=RDAP_SPACING_S)
    if st in (301, 302, 303, 307, 308):
        loc = body.strip()
        if not loc.startswith("https://"): return obs(domain, "domain_registered", None, "rdap", at=at)
        url = loc; st, body = pol.get(url, spacing=RDAP_SPACING_S)  # one hop only; robots checked on the registry host
    if st != 200: return obs(domain, "domain_registered", None, "rdap", evidence_url=url if url.startswith("https://") else None, at=at)
    try:
        ev = [e for e in json.loads(body).get("events", []) if e.get("eventAction") == "registration"]
        d = ev[0]["eventDate"][:10]; datetime.date.fromisoformat(d)
    except Exception: return obs(domain, "domain_registered", None, "rdap", evidence_url=url, at=at)
    return obs(domain, "domain_registered", {"registered": d}, "rdap", evidence_url=url, at=at)

RETURN_RX = r"\b(return|refund)s?\b"
def return_policy(pol, domain, at):
    url = f"https://{domain}/policies/refund-policy"
    st, body = pol.get(url)
    t = text_of(body) if st == 200 else ""
    q = sentence_with(t, RETURN_RX + r".{0,80}\b\d{1,3}[- ]?days?\b|\b\d{1,3}[- ]?days?\b.{0,80}" + RETURN_RX) or sentence_with(t, RETURN_RX)
    if not q: return obs(domain, "return_policy", None, "shopify-policy-page", at=at)
    m = re.search(r"\b(\d{1,3})[- ]?days?\b", q)
    return obs(domain, "return_policy", {"window_days": int(m.group(1)) if m else None}, "shopify-policy-page", url, q, at)

PHONE_RX = r"(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b"
ADDR_RX = r"\b\d{1,6}\s+[A-Za-z0-9.' -]{2,40}\s(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Suite|Ste)\b\.?"
def contact(pol, domain, at):
    for path in ("/policies/contact-information", "/pages/contact"):
        url = f"https://{domain}{path}"
        st, body = pol.get(url)
        if st != 200: continue
        t = text_of(body)
        ph, ad = re.search(PHONE_RX, t), re.search(ADDR_RX, t, re.I)
        if ph or ad:
            m = ad or ph
            q = t[max(0, m.start() - 80): m.end() + 80]
            return obs(domain, "contact", {"phone": bool(ph), "address": bool(ad)}, "contact-page", url, q, at)
    return obs(domain, "contact", None, "contact-page", at=at)

RESELLER = [("asin", re.compile(r"\b(ASIN[:\s]*)?B0[A-Z0-9]{8}\b")), ("amazon-image", re.compile(r"m\.media-amazon\.com|images-na\.ssl-images-amazon\.com", re.I)),
            ("amazon-fulfilment", re.compile(r"(ships|sold|fulfilled) (from|by) amazon", re.I))]
def reseller(pol, domain, at):
    url = f"https://{domain}/products.json?limit=50"
    st, body = pol.get(url)
    if st != 200: return obs(domain, "reseller", None, "products-json", at=at)
    try: products = json.loads(body).get("products", [])
    except Exception: return obs(domain, "reseller", None, "products-json", at=at)
    blob = " ".join(f"{p.get('title','')} {p.get('body_html','')} {json.dumps(p.get('images', []))}" for p in products if isinstance(p, dict))
    signs, quote = [], None
    for name, rx in RESELLER:
        m = rx.search(blob)
        if m:
            signs.append(name)
            quote = quote or blob[max(0, m.start() - 60): m.end() + 60]
    return obs(domain, "reseller", {"signs": signs}, "products-json", url, quote, at)

def observe(domains, precrawl_rows, pol, data_dir, known_registered=frozenset(), at=None, rdap_cap=RDAP_DAILY_CAP):
    at = at or now_s()
    ok = {norm(r.get("d", "")) for r in precrawl_rows if r.get("decision") == "crawl"}
    out, skipped, rdap_used = [], [], 0
    for d in map(norm, domains):
        if link_only(d) or d not in ok: skipped.append(d); continue
        out.append(first_seen(d, data_dir, at))
        if registrable(d) not in known_registered and rdap_used < rdap_cap:
            out.append(domain_registered(pol, d, at)); rdap_used += 1
        out += [return_policy(pol, d, at), contact(pol, d, at), reseller(pol, d, at)]
    return out, skipped

def sql_for(rows):
    esc = lambda v: "NULL" if v is None else str(v) if isinstance(v, int) else "'" + str(v).replace("'", "''") + "'"
    return "".join(f"INSERT OR IGNORE INTO store_trust_obs (id, domain, signal, value_json, evidence_url, quote, method, observed_at) VALUES ({', '.join(esc(r[k]) for k in ('id','domain','signal','value_json','evidence_url','quote','method','observed_at'))});\n" for r in rows)

def main(argv=None):
    ap = argparse.ArgumentParser(description="M4 S3 trust observations (live network; run only after the S1 widen gate passes)")
    ap.add_argument("--domains", required=True); ap.add_argument("--precrawl", required=True)
    ap.add_argument("--known-registered", help="file of registrable domains already holding a registration date")
    ap.add_argument("--data-dir", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    ap.add_argument("--out-dir", default=os.path.join(os.path.dirname(__file__), "out"))
    a = ap.parse_args(argv)
    pol = Polite()
    known = frozenset(l.strip() for l in open(a.known_registered)) if a.known_registered else frozenset()
    domains = [l.strip() for l in open(a.domains) if l.strip() and not l.startswith("#")]
    rows, skipped = observe(domains, [json.loads(l) for l in open(a.precrawl) if l.strip()], pol, a.data_dir, known)
    os.makedirs(a.out_dir, exist_ok=True); day = datetime.date.today().strftime("%Y%m%d")
    with open(os.path.join(a.out_dir, f"trust-obs-{day}.jsonl"), "w") as f: f.writelines(json.dumps(r) + "\n" for r in rows)
    with open(os.path.join(a.out_dir, f"trust-obs-{day}.sql"), "w") as f: f.write(sql_for(rows))
    print(f"trust: {len(rows)} observations, {len(skipped)} domains skipped (not allowed by the widen gate / link-out only), {len(pol.log)} requests")
    return 0

if __name__ == "__main__":
    sys.exit(main())
