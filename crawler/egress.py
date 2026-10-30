"""KIMI-007 (port of nostr-market crawler/gate.py egress guard): private-network egress guard for the public crawler.
Every destination (navigation, redirect hop, browser subresource, robots fetch) must be http(s)/ws(s), carry no
credentials, and resolve only to globally routable addresses: no loopback, RFC1918, link-local/metadata
(169.254.0.0/16), CGNAT, ULA, multicast or reserved ranges, no localhost/.local/.internal names and no odd IP
notations (0x7f.0.0.1, 2130706433). install() wires it into Playwright: a route on every new context and a check of
page.url after each goto. Known gap: DNS rebinding between this check and the browser's own lookup."""
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

def egress_check(url):
    sp = urllib.parse.urlsplit(url)
    if sp.scheme in ("data", "blob", "about"): return
    if sp.scheme not in ("http", "https", "ws", "wss"): raise EgressRefused(f"egress: scheme {sp.scheme!r} not allowed: {url[:120]}")
    if sp.username or sp.password: raise EgressRefused("egress: credentials in URL")
    if not public_host(sp.hostname): raise EgressRefused(f"egress: not a public internet host: {sp.hostname}")

_installed = False
def install():
    """Patch Playwright so every context routes requests through egress_check and every goto re-checks the final URL."""
    global _installed
    if _installed: return
    from playwright.sync_api._generated import Browser, Page
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
