import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
from status_policy import classify_fetch, combine, reclassify

class Policy(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify_fetch(403), ("refused", "403"))
        self.assertEqual(classify_fetch(403, body="<title>Access Denied</title>"), ("refused", "block-page"))
        self.assertEqual(classify_fetch(200, body="<html><title>Just a moment...</title>", content_type="text/html"), ("refused", "block-page"))
        self.assertEqual(classify_fetch(429), ("refused", "429"))
        self.assertEqual(classify_fetch(503), ("error", "5xx"))
        self.assertEqual(classify_fetch(418), ("error", "4xx"))
        self.assertEqual(classify_fetch(404), ("not-found", None))
        self.assertEqual(classify_fetch(200, body="User-agent: *"), ("ok", None))
        for exc, c in [("err:TimeoutError", "timeout"), ("gaierror: Name or service not known", "dns"),
                       ("SSLError: CERTIFICATE_VERIFY_FAILED", "tls"), ("redirect loop 301", "redirect-loop"),
                       ("err:UnicodeDecodeError", "decode"), ("ConnectionRefusedError", "connect"), ("err:Error", "unknown")]:
            self.assertEqual(classify_fetch(exc=exc), ("error", c), exc)
    def test_combine(self):
        self.assertEqual(combine([("refused", "403"), ("refused", "block-page")]), ("refused", "block-page"))
        self.assertEqual(combine([("error", "unknown"), ("error", "tls")]), ("error", "tls"))
        self.assertEqual(combine([("error", "timeout"), ("ok", None)]), ("ok", None))
    def test_reclassify(self):
        rec = {"d": "a.example", "status": "agents-not-welcome", "anw": {"type": "robots-error", "status": 403, "url": "https://a.example/robots.txt"}, "ar": []}
        r = reclassify(rec, ("refused", "block-page"), {"status": 403})
        self.assertEqual((r["status"], r["anw"]["type"]), ("agents-not-welcome", "robots-block-page"))
        r = reclassify(dict(rec, status="error"), ("error", "timeout"), {})
        self.assertEqual((r["status"], r["anw"]["type"], r["anw"]["cause"]), ("error", "robots-unreachable", "timeout"))
        self.assertEqual(r["ar"][-1]["c"], "net")
        self.assertEqual(rec["status"], "agents-not-welcome")   # not mutated
if __name__ == "__main__": unittest.main()
