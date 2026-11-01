"""Fails if any fetch helper can reach the network without going through gate.py."""
import ast, glob, os, sys, unittest, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ua, gate  # noqa: E402  (importing ua installs the gate)

FETCH = ("urlopen", "build_opener", "OpenerDirector", "http.client", "HTTPSConnection", "HTTPConnection",
         "socket.create_connection", "import requests", "import httpx", "aiohttp", "playwright", ".goto(", "new_page", "pycurl")
GATED_IMPORTS = {"ua", "gate", "crawl", "offers"}  # crawl/offers import ua, which installs the gate

def imported(path):
    mods = set()
    for n in ast.walk(ast.parse(open(path).read())):
        if isinstance(n, ast.Import): mods |= {a.name.split(".")[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.module: mods.add(n.module.split(".")[0])
    return mods

class TestEveryFetchHelperIsGated(unittest.TestCase):
    def test_every_fetch_helper_imports_the_gate(self):
        bad = []
        for p in sorted(glob.glob(os.path.join(HERE, "*.py"))):
            name = os.path.basename(p)
            if name in ("gate.py", "test_gate.py", "egress.py", "egress_proxy.py") or name.startswith("test_"): continue  # the gate layer itself
            if name == "pending_sites.py": continue  # reads only our own API (klickymart.com, gate.API_HOSTS), public-repo tool
            src = open(p).read()
            if not any(k in src for k in FETCH): continue
            if not (imported(p) & GATED_IMPORTS): bad.append(name)
        self.assertEqual(bad, [], f"fetch helpers that bypass gate.py: {bad}")

    def test_no_raw_socket_or_http_client_fetches(self):
        bad = [os.path.basename(p) for p in glob.glob(os.path.join(HERE, "*.py"))
               if os.path.basename(p) not in ("gate.py", "test_gate.py", "egress_proxy.py")  # egress_proxy is the pinning proxy itself
               and any(k in open(p).read() for k in ("http.client", "HTTPSConnection", "socket.create_connection", "import requests", "import httpx", "aiohttp", "async_playwright"))]
        self.assertEqual(bad, [], f"unpatched fetch layer used (gate covers urllib + sync playwright only): {bad}")

    def test_urlopen_is_patched(self):
        self.assertEqual(urllib.request.OpenerDirector.open.__name__, "gated_open")

class TestVerdicts(unittest.TestCase):
    def test_wacaco_is_refused_including_incident_urls(self):
        for u in ("https://www.wacaco.com/", "https://www.wacaco.com/products/prestina", "https://wacaco.com/policies/terms-of-service"):
            with self.assertRaises(gate.GateRefused): gate.check(u)
        with self.assertRaises(gate.GateRefused): urllib.request.urlopen("https://www.wacaco.com/", timeout=1)
        self.assertEqual(gate.verdict("wacaco.com")["src"], "gate_blocklist.json")

    def test_robots_txt_and_api_hosts_pass(self):
        self.assertEqual(gate.check("https://www.wacaco.com/robots.txt"), "robots.txt")
        self.assertEqual(gate.check("https://openrouter.ai/api/v1/chat/completions"), "api host")

    def test_every_blocked_or_error_record_is_refused(self):
        import json
        recs = sorted(glob.glob(os.path.join(HERE, "out", "records.v*.jsonl")))
        if not recs: self.skipTest("no records on disk")
        n = 0
        for l in open(max(recs, key=lambda p: int(p.rsplit("v", 1)[1].split(".")[0]))):
            r = json.loads(l)
            if r.get("status") in ("blocked-tos", "error", "agents-not-welcome") or r.get("tos") in ("bans-automation", "unknown"):
                with self.assertRaises(gate.GateRefused, msg=r["d"]): gate.check(f"https://{r['d']}/")
                n += 1
        self.assertGreater(n, 100)

    def test_no_verdict_means_discovery_only(self):
        with self.assertRaises(gate.GateRefused): gate.check("https://never-seen-store.example/products/x")

if __name__ == "__main__": unittest.main()
