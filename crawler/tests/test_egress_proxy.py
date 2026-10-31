"""R-C-001/002/003 (port): every fetch goes through the pinning proxy; the internal listener (127.0.0.2) is never reached."""
import os, sys, socket, threading, http.server, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import pytest
import egress

def listener(host, hits, redirect=None):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(s):
            hits.append((host, s.path))
            if redirect: s.send_response(302); s.send_header("Location", redirect); s.end_headers()
            else: s.send_response(200); s.end_headers(); s.wfile.write(b"x")
        def log_message(*a): pass
    srv = http.server.HTTPServer((host, 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv.server_address[1]

@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(egress, "_fakeip", False)
    real = egress.public_host
    monkeypatch.setattr(egress, "public_host", lambda h, resolve=None: (h or "").strip("[]") == "127.0.0.1" or (h != "127.0.0.2" and real(h, resolve)))
    egress.install()

def test_dns_rebinding_cannot_reach_internal(env, monkeypatch):
    hits = []; port = listener("127.0.0.2", hits)
    real = socket.getaddrinfo; n = {"c": 0}
    def flip(h, p, *a, **k):
        if h == "rebind.test":
            n["c"] += 1; return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34" if n["c"] == 1 else "127.0.0.2", p or 0))]
        return real(h, p, *a, **k)
    monkeypatch.setattr(socket, "getaddrinfo", flip); egress._cache.clear()
    egress.egress_check(f"http://rebind.test:{port}/")   # first answer passes the pre-check
    with pytest.raises(Exception): urllib.request.urlopen(f"http://rebind.test:{port}/latest/meta-data", timeout=5).read()
    assert hits == []

def test_browser_redirect_and_ctx_request(env):
    pw = pytest.importorskip("playwright.sync_api")
    hits = []; ip = listener("127.0.0.2", hits); internal = f"http://127.0.0.2:{ip}/meta"; pp = listener("127.0.0.1", hits, redirect=internal)
    with pw.sync_playwright() as p:
        b = p.chromium.launch(headless=True); ctx = b.new_context()
        with pytest.raises(Exception): ctx.request.get(internal)
        assert ctx.request.get(f"http://127.0.0.1:{pp}/robots.txt", max_redirects=5).status == 403
        pg = ctx.new_page()
        try: pg.goto(f"http://127.0.0.1:{pp}/home")
        except Exception: pass
        b.close()
    assert [h for h in hits if h[0] == "127.0.0.2"] == []
