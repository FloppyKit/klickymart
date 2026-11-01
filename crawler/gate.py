#!/usr/bin/env python3
"""The single fetch gate for every crawler, probe, payment-icon and drain fetch.

Every outbound HTTP(S) request made by this crawler goes through `check(url)`:
  1. robots.txt first (our UA token). A robots error, 403 or timeout counts as disallow.
  2. the stored terms verdict for the domain (records, tos.jsonl files, gate_blocklist.json):
     - tos "ok" and status crawled           -> any public page allowed (still robots-checked)
     - blocked-tos / bans-automation / error / agents-not-welcome / explicitly "unknown" -> REFUSED (robots.txt only)
     - no terms verdict yet (new or never-checked domain) -> discovery only: robots.txt, the home page and terms/policy pages,
       so tos.py can establish the verdict. Nothing else until the verdict is "ok".
`install()` enforces this at the lowest layers (urllib OpenerDirector.open, and Playwright document navigations via a context
route), and ua.py calls it, so every module that imports the UA is gated. Non-store API hosts (OpenRouter, our own site, RDAP)
are allowlisted. Refusals raise GateRefused and are appended to out/runs/gate-refusals.log.
"""
import glob, ipaddress, json, os, re, socket, threading, time, urllib.parse, urllib.request, urllib.robotparser

HERE = os.path.dirname(os.path.abspath(__file__))
O = lambda *p: os.path.join(HERE, "out", *p)
UA_TOKEN = "FloppyKitMapBot"
# P1-1: exact non-store API hosts, https only (no prefix/suffix matching). Callers: llm.py (openrouter.ai),
# pending_sites.py / ucp quote / submit queue (klickymart.com, www. is stripped by host_of), trust.py (rdap.org, whose IANA
# bootstrap redirects .com/.net -> rdap.verisign.com and .org -> rdap.publicinterestregistry.org).
API_HOSTS = frozenset({"openrouter.ai", "klickymart.com", "rdap.org", "rdap.verisign.com", "rdap.publicinterestregistry.org"})
TERMS_PATH = re.compile(r"(?i)^/(policies/terms|pages/terms|terms|tos|legal|conditions|terms[-_]of[-_](service|use|sale)|terms[-_]and[-_]conditions|policies)(/|[-_.a-z]*)?")
REFUSE_STATUS = {"blocked-tos", "error", "agents-not-welcome", "unknown", "robots-disallowed"}
REFUSE_TOS = {"bans-automation", "unknown", "error"}

class GateRefused(Exception):
    pass

_lock = threading.RLock()
_verdicts = None
_robots = {}
_bypass = threading.local()

# KIMI-007 egress primitives live in egress.py (public repo, single implementation); gate.py adds robots + terms on top.
import egress as _egress  # noqa: E402

def public_host(host, resolve=None):
    return _egress.public_host(host, resolve)

def egress_check(url):
    try: _egress.egress_check(url)
    except _egress.EgressRefused as e: _refuse(url, str(e).split(": http", 1)[0])

def host_of(url):
    h = (urllib.parse.urlsplit(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h

def _load():
    """Latest verdict per domain. Later sources override earlier ones; the blocklist always wins."""
    v = {}
    recs = sorted(glob.glob(O("records.v*.jsonl")), key=lambda p: int(re.search(r"records\.v(\d+)", p).group(1)))
    for p in recs[-1:]:
        for l in open(p):
            if l.strip():
                r = json.loads(l); v[r["d"]] = {"status": r.get("status"), "tos": r.get("tos"), "src": os.path.basename(p)}
    for p in sorted(glob.glob(O("*", "tos.jsonl"))):
        for l in open(p):
            if not l.strip(): continue
            t = json.loads(l); d = t.get("d") or t.get("domain")
            if not d or not t.get("tos"): continue
            cur = v.setdefault(d, {"status": None, "tos": None, "src": None})
            if cur.get("tos") in (None, "unknown") or t["tos"] in REFUSE_TOS: cur.update(tos=t["tos"], src=os.path.relpath(p, HERE))
    bl = os.path.join(HERE, "gate_blocklist.json")
    if os.path.exists(bl):
        for d, why in json.load(open(bl)).items():
            v[d] = {"status": "blocked-tos", "tos": "bans-automation", "src": "gate_blocklist.json", "why": why}
    return v

def verdict(domain):
    global _verdicts
    with _lock:
        if _verdicts is None: _verdicts = _load()
        d = domain[4:] if domain.startswith("www.") else domain
        return _verdicts.get(d)

def reload():
    global _verdicts
    with _lock: _verdicts = None; _robots.clear()

def _robots_ok(url):
    sp = urllib.parse.urlsplit(url); base = f"{sp.scheme}://{sp.netloc}"
    with _lock:
        rp = _robots.get(base)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser()
        try:
            _bypass.on = True
            from ua import UA
            req = urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                rp.parse(r.read().decode("utf-8", "replace").splitlines())
        except urllib.error.HTTPError as e:
            if e.code == 404: rp.parse([])          # no robots.txt: allowed
            else: rp = False                         # 403/5xx: treat as disallow
        except Exception:
            rp = False                               # timeout/network error: treat as disallow
        finally:
            _bypass.on = False
        with _lock: _robots[base] = rp
    return bool(rp) and rp.can_fetch(UA_TOKEN, url)

def check(url, purpose="page"):
    """Raise GateRefused unless this fetch is allowed. Returns the reason string when allowed."""
    egress_check(url)  # KIMI-007: before everything, including the internal robots fetch and API hosts
    if getattr(_bypass, "on", False): return "internal robots fetch"
    sp = urllib.parse.urlsplit(url)
    if sp.scheme not in ("http", "https"): return "non-http"
    h = host_of(url)
    if h in API_HOSTS:
        if sp.scheme != "https": _refuse(url, "api host over plain http")
        return "api host"
    if sp.path == "/robots.txt": return "robots.txt"
    v = verdict(h)
    status, tos = (v or {}).get("status"), (v or {}).get("tos")
    if status in REFUSE_STATUS or tos in REFUSE_TOS:
        _refuse(url, f"stored verdict status={status} tos={tos} ({(v or {}).get('src')})")
    discovery = tos != "ok"
    if discovery and not (sp.path in ("", "/") or TERMS_PATH.match(sp.path or "/") or _override_terms_url(url)):
        _refuse(url, f"no terms verdict yet (status={status} tos={tos}): only robots.txt, the home page and terms pages may be fetched")
    if not _robots_ok(url):
        _refuse(url, "robots.txt disallows (or robots.txt errored/timed out)")
    return "allowed (terms ok)" if not discovery else "allowed (terms discovery)"

_override = None
def _override_terms_url(url):
    """Exact terms URLs hand-found by web search (tos_urls.override.json) count as terms pages during discovery.
    Exact match only (scheme+host+path, no query); robots.txt is still checked after this."""
    global _override
    if _override is None:
        p = os.path.join(HERE, "tos_urls.override.json"); _override = set()
        if os.path.exists(p):
            for d, e in json.load(open(p)).items():
                for u in (e or {}).get("urls", []):
                    q = urllib.parse.urlsplit(u); _override.add((q.netloc.lower(), q.path.rstrip("/")))
    q = urllib.parse.urlsplit(url)
    return (q.netloc.lower(), q.path.rstrip("/")) in _override

def _refuse(url, why):
    url = _redact_url(url)  # R-C-006: never write captured tokens to the refusal log or exception text
    os.makedirs(O("runs"), exist_ok=True)
    with open(O("runs", "gate-refusals.log"), "a") as f:
        f.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "url": url, "why": why}) + "\n")
    raise GateRefused(f"{url}: {why}")

def _redact_url(url):
    try:
        from url_redact import clean_url, redact_str
        return redact_str(clean_url(str(url)))
    except Exception:
        return str(url).split("?", 1)[0][:200]

def vetted_addr(host, url=None):
    """R-C-003: one vetted public address (egress.vetted_addr); refusals are logged redacted and raised as GateRefused."""
    try: return _egress.vetted_addr(host, url)
    except _egress.EgressRefused as e: _refuse(url or f"https://{host}/", str(e))

def start_egress_proxy():
    """One pinning proxy per process, shared with egress.install() (egress.start_egress_proxy)."""
    return _egress.start_egress_proxy()

_installed = False
def install():
    """Patch the fetch layers once per process. Idempotent."""
    global _installed
    if _installed: return
    _installed = True
    orig_open = urllib.request.OpenerDirector.open
    def gated_open(self, fullurl, *a, **k):
        check(fullurl.full_url if isinstance(fullurl, urllib.request.Request) else fullurl)
        return orig_open(self, fullurl, *a, **k)
    urllib.request.OpenerDirector.open = gated_open
    proxy = start_egress_proxy()  # R-C-001/002/003: every byte the crawler sends goes through the pinning proxy
    try:
        from playwright.sync_api._generated import Browser, BrowserContext, BrowserType, APIRequestContext
        # Force the browser (and its contexts' APIRequestContext) through the proxy, loopback included.
        def _proxied(k):
            k = dict(k); k.setdefault("proxy", {"server": proxy})
            k["args"] = list(k.get("args") or []) + ["--proxy-bypass-list=<-loopback>"]
            return k
        for name in ("launch", "launch_persistent_context"):
            orig_l = getattr(BrowserType, name)
            def wrap_l(self, *a, __orig=orig_l, **k): return __orig(self, *a, **_proxied(k))
            setattr(BrowserType, name, wrap_l)
        # R-C-001: ctx.request.* also runs the full gate (terms + egress) on the first URL; hops go via the proxy.
        for name in ("get", "post", "head", "fetch", "put", "delete", "patch"):
            orig_r = getattr(APIRequestContext, name, None)
            if orig_r is None: continue
            def wrap_r(self, url_or_request, *a, __orig=orig_r, **k):
                check(url_or_request if isinstance(url_or_request, str) else getattr(url_or_request, "url", str(url_or_request)))
                return __orig(self, url_or_request, *a, **k)
            setattr(APIRequestContext, name, wrap_r)
        def route_handler(route):
            req = route.request
            try:
                if req.resource_type == "document" or req.is_navigation_request(): check(req.url)
                else: egress_check(req.url)  # KIMI-007: subresources, XHR, websockets: public hosts only
            except GateRefused: return route.abort("blockedbyclient")
            return route.continue_()
        def gate_ctx(ctx):
            if not getattr(ctx, "_km_gated", False):
                ctx.route("**/*", route_handler); ctx._km_gated = True
            return ctx
        for cls, name in ((Browser, "new_context"), (BrowserType, "launch_persistent_context")):
            orig = getattr(cls, name)
            def wrap(self, *a, __orig=orig, **k): return gate_ctx(__orig(self, *a, **k))
            setattr(cls, name, wrap)
        orig_np = Browser.new_page
        def new_page(self, *a, **k):
            p = orig_np(self, *a, **k); gate_ctx(p.context); return p
        Browser.new_page = new_page
        from playwright.sync_api._generated import Page
        orig_goto = Page.goto
        def goto(self, url, *a, **k):
            check(url); r = orig_goto(self, url, *a, **k)
            egress_check(self.url)  # KIMI-007: the final URL after redirects must be public too
            return r
        Page.goto = goto
    except ImportError:
        pass
