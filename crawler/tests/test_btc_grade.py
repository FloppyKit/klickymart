import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
from btc_grade import grade_record, apply
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
        self.assertEqual(g, 3); self.assertIn("hosted by Start9", i["quote"])
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

if __name__ == "__main__": unittest.main()
