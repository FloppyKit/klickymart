"""Offline tests for ucp_quote.py (UQ-1..UQ-5). Synthetic probe fixture; no real network (local 127.0.0.1 server only)."""
import os, sys, json, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import ucp_quote as U

FAKE = {"name": "Zoë Testperson", "email": "zoe@example.invalid", "phone": "555-0100",
        "address": {"line1": "1 Fake Street", "line2": "Suite 9", "city": "Sámpleville", "state": "ZZ", "zip": "00000", "country": "US"}}

class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); p = os.path.join(self.tmp, "probe.json"); 
        with open(p, "w") as f: json.dump(FAKE, f)
        U.load_probe(p); U.LEDGER = os.path.join(self.tmp, "ledger.jsonl"); U.PACE = 0
        self.p = [mock.patch.object(U.gate, "check", lambda u: None), mock.patch.object(U.time, "sleep", lambda s: None)]
        for x in self.p: x.start()
    def tearDown(self):
        for x in self.p: x.stop()
    def events(self): return [json.loads(l)["ev"] for l in open(U.LEDGER)]

SEARCH = {"products": [{"title": "Tee", "variants": [{"id": "v1", "price": {"amount": 1000}}]}]}
def fake_call(create, cancel_status="canceled", cancel_http=200, on_update=None):
    calls = []
    def f(d, name, args, with_status=False):
        calls.append(name)
        if name == "search_catalog": return SEARCH
        if name == "create_checkout":
            if isinstance(create, BaseException): raise create
            return create
        if name == "update_checkout":
            if on_update: raise on_update
        if name == "cancel_checkout":
            r = (cancel_http, {"checkout": {"id": args["id"], "status": cancel_status}}); return r if with_status else r[1]
        return {}
    return f, calls

class UQ1(Base):
    def test_missing_id_not_ok_and_flagged(self):
        f, _ = fake_call({"checkout": {"status": "open"}})
        with mock.patch.object(U, "call", f): r = U.quote("x.test", "t")
        self.assertFalse(r["ok"]); self.assertEqual(self.events(), ["intent", "open_no_id"])
        self.assertEqual(len(U.open_entries()), 1)
    def test_timeout_on_create_flagged(self):
        f, _ = fake_call(TimeoutError("timed out"))
        with mock.patch.object(U, "call", f): r = U.quote("x.test", "t")
        self.assertFalse(r["ok"]); self.assertEqual(self.events(), ["intent", "open_unknown"])
    def test_ctrl_c_still_cancels(self):
        co = {"checkout": {"id": "c1", "fulfillment": {"methods": [{"groups": [{"id": "g", "options": [{"id": "o", "title": "S", "amount": 5}]}]}]}}}
        f, calls = fake_call(co, on_update=KeyboardInterrupt())
        with mock.patch.object(U, "call", f), self.assertRaises(KeyboardInterrupt): U.quote("x.test", "t")
        self.assertIn("cancel_checkout", calls); self.assertEqual(self.events(), ["intent", "created", "cancelled"])
        self.assertEqual(U.open_entries(), [])
    def test_cleanup_cancels_open(self):
        U.ledger("intent", key="k", d="x.test"); U.ledger("created", key="k", d="x.test", cid="c9")
        f, calls = fake_call(None)
        with mock.patch.object(U, "call", f): res = U.cleanup()
        self.assertEqual(res[0]["result"], "cancelled"); self.assertEqual(U.open_entries(), [])

class UQ2(Base):
    def run_(self, st, http):
        f, _ = fake_call({"checkout": {"id": "c1"}}, cancel_status=st, cancel_http=http)
        with mock.patch.object(U, "call", f): return U.quote("x.test", "t")
    def test_confirmed(self):
        for s in ("canceled", "cancelled"): r = self.run_(s, 200); self.assertTrue(r["cancelled"]); self.assertEqual(r["cancel"], "cancelled")
    def test_unconfirmed_status(self):
        r = self.run_("open", 200); self.assertFalse(r["cancelled"]); self.assertEqual(r["cancel"], "cancel_unconfirmed")
        self.assertEqual(len(U.open_entries()), 1)
    def test_unconfirmed_http(self):
        r = self.run_("canceled", 202); self.assertTrue(r["cancelled"])
        r = self.run_("canceled", 500); self.assertEqual(r["cancel"], "cancel_unconfirmed")

class UQ3(Base):
    def test_structural_accent_case(self):
        obj = {"note": "ship to ZOE at sampleville zz 00000", "msg": "José? no: zoë testperson, 1 fake street",
               "first_name": "Q", "nested": [{"postal_code": "x", "t": "Testperson Suite 9"}], "amt": 12}
        s = U.emit(obj)
        self.assertEqual(U.leaks(s), []); self.assertIn("[redacted]", s); self.assertIn("12", s)
        self.assertEqual(json.loads(s)["first_name"], "[redacted]")
    def test_escaped_text_not_leaked(self):
        s = U.emit({"x": "hello Zoë"}); self.assertNotIn("\\u00eb", s.lower().replace("[redacted]", ""))
        self.assertEqual(U.leaks(s), [])
    def test_error_text_scrubbed(self):
        f, _ = fake_call(RuntimeError("bad address Sámpleville, ZZ 00000 for zoe@example.invalid"))
        with mock.patch.object(U, "call", f): r = U.quote("x.test", "t")
        self.assertEqual(U.leaks(json.dumps(r)), [])

class _H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path == "/redir":
            self.send_response(302); self.send_header("Location", "http://169.254.169.254/"); self.end_headers(); return
        body = b'{"a":"' + b"x" * (U.MAX_BYTES + 10) + b'"}' if self.path == "/big" else b'{"result":{}}'
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

class Local(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = HTTPServer(("127.0.0.1", 0), _H); threading.Thread(target=cls.s.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.s.server_port}"
        cls.g = mock.patch.object(U.gate, "check", lambda u: None); cls.g.start()
        cls.o = mock.patch.object(U, "OPENER", U.urllib.request.build_opener(U.urllib.request.ProxyHandler({}), U._NoRedirect)); cls.o.start()  # no proxy; allow loopback test server only
    @classmethod
    def tearDownClass(cls): cls.o.stop(); cls.g.stop(); cls.s.shutdown(); cls.s.server_close()
    def test_uq4_redirect_refused(self):
        with self.assertRaisesRegex(RuntimeError, "302"): U.http_post(self.base + "/redir", b"{}")
    def test_uq5_size_cap(self):
        with self.assertRaisesRegex(RuntimeError, "1 MB"): U.http_post(self.base + "/big", b"{}")
    def test_ok(self):
        self.assertEqual(U.http_post(self.base + "/ok", b"{}"), (200, {"result": {}}))

if __name__ == "__main__": unittest.main()
