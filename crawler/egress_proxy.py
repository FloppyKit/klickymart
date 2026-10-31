"""R-C-002 / R-C-003 / R-C-001: local pinning egress proxy for every crawler fetch.

All browser traffic (navigations, every redirect hop, subresources, XHR, websockets, service workers and the
context's APIRequestContext, i.e. ctx.request.get) and all urllib traffic is sent through this in-process proxy. For each
new upstream connection the proxy resolves the host ONCE, refuses unless every answer is a public address (via the
caller's `vet` function), and then connects to that exact vetted IP. Nothing re-resolves after the check, so DNS
rebinding cannot swap in 127.0.0.1 / 169.254.169.254 between check and connect, and a redirect to an internal host is
refused before any byte is sent to it. Plain-HTTP requests are forced to `Connection: close` so one client connection
can never be reused for a different host."""
import select, socket, socketserver, threading, urllib.parse

MAX_HEAD = 65536

class Refused(Exception):
    pass

def _read_head(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk: break
        buf += chunk
        if len(buf) > MAX_HEAD: raise Refused("request head too large")
    return buf

def _pipe(a, b, idle=60):
    socks = [a, b]
    while True:
        r, _, x = select.select(socks, [], socks, idle)
        if x or not r: return
        for s in r:
            try: data = s.recv(65536)
            except OSError: return
            if not data: return
            (b if s is a else a).sendall(data)

class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        c = self.request; up = None
        try:
            head = _read_head(c)
            if not head: return
            line, _, rest = head.partition(b"\r\n")
            method, target, ver = line.decode("latin-1").split(" ", 2)
            if method.upper() == "CONNECT":
                host, _, port = target.rpartition(":"); host = host.strip("[]"); port = int(port or 443)
                url = f"https://{host}:{port}/"
            else:
                sp = urllib.parse.urlsplit(target)
                if sp.scheme not in ("http", "ws"): raise Refused(f"scheme {sp.scheme!r} not allowed")
                if sp.username or sp.password: raise Refused("credentials in URL")
                host, port = sp.hostname, sp.port or 80; url = target
            ip = self.server.vet(host, url)          # raises on refusal; returns the ONE address we will connect to
            up = socket.create_connection((ip, port), timeout=30)
            if method.upper() == "CONNECT":
                c.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            else:
                sp = urllib.parse.urlsplit(target)
                path = (sp.path or "/") + (f"?{sp.query}" if sp.query else "")
                hdr, _, body = rest.partition(b"\r\n\r\n")
                lines = [l for l in hdr.split(b"\r\n") if l and not l.lower().startswith((b"proxy-connection:", b"connection:", b"keep-alive:"))]
                up.sendall(f"{method} {path} {ver}\r\n".encode("latin-1") + b"\r\n".join(lines) + b"\r\nConnection: close\r\n\r\n" + body)
            _pipe(c, up)
        except Exception as e:
            try: c.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\negress refused: " + str(e)[:200].encode("utf-8", "replace"))
            except OSError: pass
        finally:
            for s in (up, c):
                try: s and s.close()
                except OSError: pass

class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True; allow_reuse_address = True

_srv = None; _lock = threading.Lock()
def start(vet):
    """Start (once per process) and return 'http://127.0.0.1:PORT'. vet(host, url) -> ip or raise."""
    global _srv
    with _lock:
        if _srv is None:
            _srv = _Server(("127.0.0.1", 0), _Handler); _srv.vet = vet
            threading.Thread(target=_srv.serve_forever, daemon=True, name="egress-proxy").start()
        return f"http://127.0.0.1:{_srv.server_address[1]}"
