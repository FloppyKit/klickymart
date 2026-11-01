"""Offline tests for verify_402.parse L402/LSAT challenge storage. Fixture strings only; no network."""
import os, sys, json, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import verify_402 as V

INV = "lnbc2500n1pjfaketestqpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qxpqysgqfakefakefake"
MAC = "AgEEbHNhdAJCAAD3fakemacaroonbase64=="

class T(unittest.TestCase):
    def test_l402_quoted(self):
        r = V.parse(402, {"WWW-Authenticate": f'L402 macaroon="{MAC}", invoice="{INV}", version="0"'}, "")
        self.assertEqual(r["proto"], "l402"); c = r["l402"]
        self.assertEqual((c["scheme"], c["invoice"], c["macaroon"], c["macaroon_len"]), ("L402", INV, MAC, len(MAC)))
        self.assertEqual(c["params"], {"version": "0"}); self.assertFalse(c["truncated"])
        self.assertEqual(r["price_seen"]["amount"], 250.0)
    def test_lsat_unquoted_order(self):
        c = V.parse(402, {"WWW-Authenticate": f"LSAT invoice={INV}, macaroon={MAC}"}, "")["l402"]
        self.assertEqual((c["scheme"], c["invoice"], c["macaroon"]), ("LSAT", INV, MAC))
    def test_cap(self):
        big = "x" * 10000
        c = V.parse(402, {"WWW-Authenticate": f'L402 macaroon="{big}", invoice="{INV}"'}, "")["l402"]
        self.assertEqual(len(c["macaroon"]), V.CAP); self.assertEqual(c["macaroon_len"], 10000); self.assertTrue(c["truncated"])
        self.assertLessEqual(len(c["raw"]), V.CAP)
    def test_json_body(self):
        for k in ("invoice", "payment_request"):
            r = V.parse(402, {}, json.dumps({k: INV, "macaroon": MAC}))
            self.assertEqual(r["l402"]["invoice"], INV); self.assertEqual(r["l402"]["field"], k); self.assertEqual(r["l402"]["macaroon"], MAC)
    def test_json_nested(self):
        r = V.parse(402, {}, json.dumps({"data": {"paymentRequest": INV}}))
        self.assertEqual(r["l402"]["invoice"], INV)
    def test_non_402_and_x402_unchanged(self):
        self.assertEqual(V.parse(200, {"WWW-Authenticate": f'L402 macaroon="{MAC}", invoice="{INV}"'}, ""), {"http": 200})
        r = V.parse(402, {}, json.dumps({"x402Version": 1, "accepts": [{"maxAmountRequired": "10", "asset": "USDC"}]}))
        self.assertEqual(r["proto"], "x402"); self.assertNotIn("l402", r)
    def test_no_invoice(self):
        self.assertNotIn("l402", V.parse(402, {"WWW-Authenticate": 'L402 macaroon="abc"'}, ""))

if __name__ == "__main__": unittest.main()
