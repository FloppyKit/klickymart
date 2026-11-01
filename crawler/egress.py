"""KIMI-007 (port of nostr-market crawler/gate.py egress guard): private-network egress guard for the public crawler.
Every destination (navigation, redirect hop, browser subresource, robots fetch) must be http(s)/ws(s), carry no
credentials, and resolve only to globally routable addresses: no loopback, RFC1918, link-local/metadata
(169.254.0.0/16), CGNAT, ULA, multicast or reserved ranges, no localhost/.local/.internal names and no odd IP
notations (0x7f.0.0.1, 2130706433). install() wires it into Playwright: a route on every new context and a check of
page.url after each goto. All browser traffic (every redirect hop, ctx.request.*) and urllib go through the in-process
pinning proxy (egress_proxy.py), which resolves once and connects to the vetted IP, so DNS rebinding and redirects to
internal hosts are refused before any byte is sent (R-C-001/002/003)."""
import ipaddress, os, re, socket, threading, time, urllib.parse

class EgressRefused(Exception):
    pass

_lock = threading.Lock()
_cache = {}
TTL_S = 300
FAKEIP_NET = ipaddress.ip_network("198.18.0.0/15")
_fakeip = None

def _fakeip_mode():
    """Sandboxes that resolve every name into 198.18.0.0/15 (transparent proxy) are detected once; names resolving
    there are accepted, literals in that range are still refused. KM_EGRESS_FAKEIP=0/1 overrides."""
    global _fakeip
    if _fakeip is None:
        env = os.environ.get("KM_EGRESS_FAKEIP")
        if env in ("0", "1"): _fakeip = env == "1"
        else:
            try: _fakeip = all(ipaddress.ip_address(i[4][0]) in FAKEIP_NET for i in socket.getaddrinfo("example.com", None))
            except Exception: _fakeip = False
    return _fakeip

def _addr_public(a, resolved=False):
    ip = ipaddress.ip_address(a)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped: ip = ip.ipv4_mapped
    if resolved and ip in FAKEIP_NET and _fakeip_mode(): return True
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local or ip.is_private)

def public_host(host, resolve=None):
    h = (host or "").strip().lower().rstrip(".")
    if not h or h == "localhost" or h.endswith((".localhost", ".local", ".internal", ".lan", ".home.arpa")): return False
    h = h.strip("[]")
    try:
        return _addr_public(h)
    except ValueError:
        pass
    if re.fullmatch(r"[0-9a-fx.]+", h) or not re.fullmatch(r"[a-z0-9.-]+", h): return False
    now = time.time()
    with _lock: c = _cache.get(h)
    if c and now - c[1] < TTL_S and resolve is None: return c[0]
    try:
        addrs = {i[4][0] for i in (resolve or socket.getaddrinfo)(h, None)}
        ok = bool(addrs) and all(_addr_public(a.split("%")[0], resolved=True) for a in addrs)
    except Exception:
        ok = False
    if resolve is None:
        with _lock: _cache[h] = (ok, now)
    return ok

_ANY_URL = re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s\"'<>]+")
def redact(s):
    """P2-1: the ONE redact helper for refusal urls and reasons, any scheme: drop userinfo, query and fragment, then the
    url_redact token rules. Never raises."""
    s = str(s)
    def _one(m):
        u = m.group(0)
        try:
            sp = urllib.parse.urlsplit(u)
            return urllib.parse.urlunsplit((sp.scheme, sp.netloc.rsplit("@", 1)[-1], sp.path, "", ""))
        except ValueError: return "[redacted-url]"
    s = _ANY_URL.sub(_one, s)
    s = re.sub(r"(?i)\b(macaroon|token|preimage|authorization)=\S+", r"\1=[redacted]", s)
    try:
        from url_redact import redact_str
        return redact_str(s)
    except Exception: return s

def egress_check(url):
    sp = urllib.parse.urlsplit(url)
    if sp.scheme in ("data", "blob", "about"): return
    if sp.scheme not in ("http", "https", "ws", "wss"): raise EgressRefused(f"egress: scheme {sp.scheme!r} not allowed: {redact(url)[:120]}")
    if sp.username or sp.password: raise EgressRefused("egress: credentials in URL")
    if not public_host(sp.hostname): raise EgressRefused(f"egress: not a public internet host: {sp.hostname}")

def _literal(h):
    try: ipaddress.ip_address(h); return True
    except ValueError: return False

def vetted_addr(host, url=None):
    """R-C-003: resolve ONCE and return the one public address to connect to (the proxy never re-resolves)."""
    h = (host or "").strip().lower().rstrip(".").strip("[]")
    bad = f"egress: not a public internet host: {h}"
    if _literal(h):
        if not public_host(h): raise EgressRefused(bad)
        return h
    if not h or h == "localhost" or h.endswith((".localhost", ".local", ".internal", ".lan", ".home.arpa")) \
            or re.fullmatch(r"[0-9a-fx.]+", h) or not re.fullmatch(r"[a-z0-9.-]+", h):
        raise EgressRefused(bad)
    try: addrs = [i[4][0].split("%")[0] for i in socket.getaddrinfo(h, None, type=socket.SOCK_STREAM)]
    except Exception as e: raise EgressRefused(f"egress: resolve failed for {h} ({type(e).__name__})")
    if not addrs or not all(_addr_public(a, resolved=True) for a in addrs): raise EgressRefused(bad)
    return addrs[0]

PROXY_URL = None
def start_egress_proxy():
    """R-C-001/002/003: in-process pinning proxy; urllib is pointed at it through the standard proxy env vars."""
    global PROXY_URL
    if PROXY_URL: return PROXY_URL
    import urllib.request, egress_proxy
    PROXY_URL = egress_proxy.start(lambda host, url: vetted_addr(host, url))
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"): os.environ[k] = PROXY_URL
    for k in ("no_proxy", "NO_PROXY"): os.environ.pop(k, None)
    urllib.request._opener = None
    return PROXY_URL

_installed = False
def install():
    """Patch Playwright so every context routes requests through egress_check and every goto re-checks the final URL."""
    global _installed
    if _installed: return
    from playwright.sync_api._generated import Browser, BrowserType, Page, APIRequestContext
    proxy = start_egress_proxy()
    def _proxied(k):
        k = dict(k); k.setdefault("proxy", {"server": proxy})
        k["args"] = list(k.get("args") or []) + ["--proxy-bypass-list=<-loopback>"]
        return k
    for name in ("launch", "launch_persistent_context"):
        orig_l = getattr(BrowserType, name)
        def wrap_l(self, *a, __orig=orig_l, **k): return __orig(self, *a, **_proxied(k))
        setattr(BrowserType, name, wrap_l)
    for name in ("get", "post", "head", "fetch", "put", "delete", "patch"):  # R-C-001: ctx.request.* checked too
        orig_r = getattr(APIRequestContext, name, None)
        if orig_r is None: continue
        def wrap_r(self, u, *a, __orig=orig_r, **k):
            egress_check(u if isinstance(u, str) else getattr(u, "url", str(u))); return __orig(self, u, *a, **k)
        setattr(APIRequestContext, name, wrap_r)
    def route_handler(route):
        try: egress_check(route.request.url)
        except EgressRefused: return route.abort("blockedbyclient")
        return route.continue_()
    orig_new = Browser.new_context
    def new_context(self, *a, **k):
        ctx = orig_new(self, *a, **k); ctx.route("**/*", route_handler); return ctx
    Browser.new_context = new_context
    orig_goto = Page.goto
    def goto(self, url, *a, **k):
        egress_check(url); r = orig_goto(self, url, *a, **k); egress_check(self.url); return r
    Page.goto = goto
    _installed = True
