import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
from btc_grade import grade_record, apply, grade_sort_key, BASIS_BOUND
Q = lambda q, c="btc": {"c": c, "neg": False, "q": q, "url": "https://s.example/faq", "conf": "med", "scope": "online"}
P = lambda **k: dict({"step_reached": "payment_methods", "methods": [{"c": "btc", "ev": "Bitcoin"}], "processors": [], "privacy": ["noacct"], "path": [["checkout_click", "a", "b", "https://s.example/checkout/"]]}, **k)

class Grade(unittest.TestCase):
    def test_insufficient_left_empty(self):
        g, i = grade_record({"pay_q": [Q("We accept Bitcoin at checkout")]})
        self.assertIsNone(g); self.assertEqual(i["range"], "1-4"); self.assertIn("not evidenced", i["reason"])
    def test_btcpay_unknown_host(self):
        g, i = grade_record({"pay_q": []}, P(processors=[{"p": "btcpay", "custodial": False, "selfhosted": False}]))
        self.assertIsNone(g); self.assertEqual(i["range"], "2-3")
    def test_selfhosted_3_and_4(self):
        sh = [{"p": "btcpay", "custodial": False, "selfhosted": True}]
        self.assertEqual(grade_record({"pay_q": []}, P(processors=sh))[0], 3)
        self.assertEqual(grade_record({"pay_q": [Q("Pay with Cashu ecash", "cashu")]}, P(processors=sh))[0], 4)
    def test_first_party_text_selfhosted(self):
        q = Q("Enter our Bitcoin Store! This is hosted by Start9, only the minimum necessary shipping information is required to purchase with Bitcoin/Lightning", "ln")
        g, i = grade_record({"d": "start9.com", "pay_q": [q]})
        self.assertIsNone(g); self.assertEqual(i["range"], "3-4 claimed"); self.assertEqual(i["basis"], "claimed")
        self.assertIn("hosted by Start9", i["quote"])
        self.assertIsNone(grade_record({"d": "other.com", "pay_q": [q]})[0])   # hosted by someone else: not self-hosted
    def test_custodial_2(self):
        g, i = grade_record({"pay_q": []}, P(processors=[{"p": "opennode", "custodial": True, "selfhosted": False}]))
        self.assertEqual(g, 2); self.assertEqual(i["src"], "agent-evidence"); self.assertTrue(i["quote"] and i["url"])
    def test_fiat_convert_1(self):
        self.assertEqual(grade_record({"pay_q": [Q("Pay with bitcoin via an exchange account linked at checkout")]})[0], 1)
    def test_zero_needs_payment_screen(self):
        self.assertEqual(grade_record({"pay_q": []}, P(methods=[{"c": "card", "ev": "Card"}]))[0], 0)
        self.assertIsNone(grade_record({"pay_q": []}, P(step_reached="cart", methods=[]))[0])
    def test_hand_kept_and_apply_fields(self):
        self.assertEqual(apply({"btc": 4, "btc_src": "hand"})["btc"], 4)
        r = apply({"pay_q": [Q("We accept Bitcoin at checkout")], "btc": 0})
        self.assertIsNone(r["btc"]); self.assertIsNone(r["btc_src"]); self.assertTrue(r["btc_grade_reason"]); self.assertTrue(r["btc_any"])

class Basis(unittest.TestCase):
    TXT = Q("Guest checkout, no account needed. Pay with bitcoin on our own node (self-hosted BTCPay).")
    def test_text_only_selfhosted_capped(self):
        g, i = grade_record({"pay_q": [self.TXT]})
        self.assertIsNone(g); self.assertEqual(i["range"], "3-4 claimed"); self.assertEqual(i["basis"], "claimed")
        self.assertTrue(i["quote"]); self.assertTrue(i["url"])
        r = apply({"pay_q": [self.TXT]})
        self.assertIsNone(r["btc"]); self.assertEqual(r["btc_grade_range"], "3-4 claimed"); self.assertEqual(r["btc_grade_basis"], "claimed")
        self.assertTrue(r["btc_grade_quote"])
    def test_same_with_probe_processors_observed(self):
        sh = [{"p": "btcpay", "custodial": False, "selfhosted": True}]
        g, i = grade_record({"pay_q": [self.TXT]}, P(processors=sh)); self.assertEqual((g, i["basis"]), (3, "observed"))
        g, i = grade_record({"pay_q": [self.TXT, Q("Pay with Cashu ecash", "cashu")]}, P(processors=sh)); self.assertEqual((g, i["basis"]), (4, "observed"))
        self.assertEqual(apply({"pay_q": [self.TXT]}, P(processors=sh))["btc_grade_basis"], "observed")
    def test_text_downgrade_1_claimed(self):
        g, i = grade_record({"pay_q": [Q("Pay with bitcoin via an exchange account linked at checkout")]})
        self.assertEqual((g, i["basis"]), (1, "claimed"))
    def test_zero_no_bitcoin_claimed(self):
        g, i = grade_record({"pay_q": []}, P(methods=[{"c": "card", "ev": "Card"}]))
        self.assertEqual((g, i["basis"]), (0, "claimed"))
    def test_bound_never_emitted(self):
        self.assertEqual(BASIS_BOUND, "bound")
        self.assertNotEqual(grade_record({"pay_q": [self.TXT]}, P(processors=[{"p": "btcpay", "selfhosted": True}]))[1]["basis"], "bound")
    def test_ordering_grade_then_basis(self):
        items = [(2, "claimed"), (3, "observed"), (None, "claimed"), (2, "observed"), (2, "bound"), (0, "claimed")]
        self.assertEqual(sorted(items, key=lambda x: grade_sort_key(*x)),
                         [(3, "observed"), (2, "bound"), (2, "observed"), (2, "claimed"), (0, "claimed"), (None, "claimed")])

if __name__ == "__main__": unittest.main()
