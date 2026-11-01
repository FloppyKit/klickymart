import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from an402 import slim_l402

FAKE = "lnbc10n1pfakeinvoicexyz0000000000000000000000000000"


class SlimL402(unittest.TestCase):
    def test_passes_through_slim(self):
        v4 = {"result": "verified-402", "l402": {"scheme": "L402", "invoice": FAKE, "macaroon": "AGIAJEem", "macaroon_len": 8,
                                                 "params": {}, "raw": 'L402 macaroon="AGIAJEem", invoice="%s"' % FAKE, "truncated": False}}
        self.assertEqual(slim_l402(v4), {"scheme": "L402", "invoice": FAKE, "truncated": False})

    def test_json_body_variant(self):
        v4 = {"l402": {"scheme": "json-body", "field": "invoice", "invoice": FAKE, "raw": "{}", "truncated": True}}
        self.assertEqual(slim_l402(v4), {"scheme": "json-body", "invoice": FAKE, "truncated": True})

    def test_omitted_when_absent(self):
        self.assertIsNone(slim_l402({"result": "no-402"}))
        self.assertIsNone(slim_l402(None))


if __name__ == "__main__":
    unittest.main()
