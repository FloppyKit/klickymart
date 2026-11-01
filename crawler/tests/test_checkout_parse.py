import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
from checkout_parse import (find_methods, find_processors, classify_gate, btc_offered, privacy_hints, grade, merge, is_candidate)
import checkout_probe

WOO = """Your order
Payment method
Credit Card (Stripe)
Bitcoin / Lightning (BTCPay Server)
Pay with Cashu ecash
Place order"""

class Parse(unittest.TestCase):
    def test_methods(self):
        c = [m["c"] for m in find_methods(WOO)]
        for x in ("card", "btc", "ln", "cashu"): self.assertIn(x, c)
        self.assertNotIn("crypto", [m["c"] for m in find_methods("Pay with Bitcoin or other cryptocurrency")])
        self.assertEqual(find_methods("Pay with crypto")[0]["c"], "crypto")
        self.assertTrue(all(m["ev"] for m in find_methods(WOO)))

    def test_processors_selfhosted(self):
        p = find_processors('<iframe src="https://pay.shop.example/i/abc">btcpay</iframe>', "shop.example", ["pay.shop.example"])
        self.assertTrue(p[0]["selfhosted"]); self.assertFalse(p[0]["custodial"])
        p = find_processors("checkout.btcpayjungle.com btcpay", "shop.example", ["checkout.btcpayjungle.com"])
        self.assertFalse(p[0]["selfhosted"])
        self.assertEqual({x["p"] for x in find_processors("opennode.com/checkout", "a.example")}, {"opennode"})

    def test_gate(self):
        self.assertEqual(classify_gate(["email Email"]), "after_contact_form")
        self.assertEqual(classify_gate(["email", "address1 Street address"]), "after_address")
        self.assertIsNone(classify_gate(["coupon"]))

    def test_btc_offered(self):
        self.assertEqual(btc_offered(find_methods(WOO), [], "payment_methods"), "yes")
        self.assertEqual(btc_offered([{"c": "card", "ev": "x"}], [], "payment_methods"), "no")
        self.assertEqual(btc_offered([{"c": "card", "ev": "x"}], [], "checkout"), "unknown")
        self.assertEqual(btc_offered([], [{"p": "opennode", "custodial": True, "selfhosted": False}], "checkout"), "yes")

    def test_privacy_and_grade(self):
        sh = [{"p": "btcpay", "custodial": False, "selfhosted": True}]
        priv = privacy_hints(find_methods(WOO), sh, WOO, True)
        self.assertEqual(priv, ["ecash", "noacct", "selfhosted"])
        self.assertEqual(grade({"btc_offered": "yes", "privacy": priv, "processors": sh}), 4)
        self.assertEqual(grade({"btc_offered": "yes", "privacy": ["noacct", "selfhosted"], "processors": sh}), 3)
        self.assertEqual(grade({"btc_offered": "yes", "privacy": ["noacct"], "processors": [{"p": "opennode", "custodial": True}]}), 2)
        self.assertIsNone(grade({"btc_offered": "yes", "privacy": ["noacct"], "processors": []}))
        self.assertIsNone(grade({"btc_offered": "unknown"}))
        self.assertEqual(grade({"btc_offered": "no"}), 0)

class Merge(unittest.TestCase):
    R = {"d": "shop.example", "btc": None, "btc_any": False, "pay": ["card"]}
    P = {"d": "shop.example", "ts": 5, "step_reached": "payment_methods", "pm_visible": "yes", "btc_offered": "yes",
         "methods": [{"c": "card"}, {"c": "ln"}], "privacy": ["noacct", "selfhosted"],
         "processors": [{"p": "btcpay", "custodial": False, "selfhosted": True}], "shot": "out/checkout-shots/x.png"}
    def test_merge(self):
        m = merge(self.R, self.P)
        self.assertEqual((m["btc"], m["btc_src"], m["btc_any"]), (3, "checkout-probe", True))
        self.assertEqual(m["btc_priv"], ["noacct", "selfhosted"]); self.assertEqual(m["pay_checkout"], ["card", "ln"])
        self.assertEqual(self.R["btc"], None)   # input not mutated
    def test_no_downgrade_hand_grade(self):
        m = merge(dict(self.R, btc=4, btc_src="hand", btc_grade_hand_at="2026-10-30"), self.P, today="2026-11-01"); self.assertEqual(m["btc"], 4)
    def test_inconclusive_keeps_grade(self):
        m = merge(dict(self.R, btc=2), dict(self.P, btc_offered="unknown", step_reached="cart", privacy=[]))
        self.assertEqual(m["btc"], 2); self.assertNotIn("btc_priv", m); self.assertNotIn("pay_checkout", m)
    def test_wrong_domain_ignored(self):
        self.assertEqual(merge(self.R, dict(self.P, d="other.example")), self.R)

class Candidates(unittest.TestCase):
    def test_candidates(self):
        self.assertTrue(is_candidate({"d": "a.example", "pay": ["ln"]}))
        self.assertTrue(is_candidate({"d": "a.example", "pay_q": [{"c": "crypto"}]}))
        self.assertTrue(is_candidate({"d": "n.example"}, {"n.example"}))
        self.assertFalse(is_candidate({"d": "a.example", "pay": ["card", "pp"]}))

class Safety(unittest.TestCase):
    def test_forbidden_labels(self):
        for s in ("Place order", "Complete purchase", "Pay now", "Confirm", "Sign in", "Create account", "Buy now"):
            self.assertTrue(checkout_probe.FORBIDDEN.search(s), s)
        for s in ("Add to cart", "Check out", "Proceed to checkout"):
            self.assertFalse(checkout_probe.FORBIDDEN.search(s), s)
    def test_limits(self):
        self.assertLessEqual(checkout_probe.MAX_LOADS, 15); self.assertGreaterEqual(checkout_probe.SPACING, 2)
    def test_typing_only_in_fill_contact(self):
        with open(os.path.join(os.path.dirname(HERE), "checkout_probe.py")) as f: src = f.read()
        self.assertEqual(src.count(".fill("), 1)
        body = src.split("def fill_contact")[1].split("\ndef ")[0]; self.assertIn(".fill(", body)
        for bad in (".type(", ".press(", "set_input_files"): self.assertNotIn(bad, src)
    def test_contact_plan(self):
        P = checkout_probe
        self.assertEqual(P.site_slug("bestbuy.com"), "bestbuy"); self.assertEqual(P.site_slug("store.coinkite.com"), "coinkite")
        self.assertEqual(P.site_slug("shop.example.co.uk"), "example")
        plan = {f: v for f, k, v in P.contact_plan(["email Email", "firstName First name", "lastName Last name", "phone Phone", "cc-number"], "bestbuy.com")}
        self.assertEqual(plan, {"email Email": "bot+bestbuy@klickymart.com", "firstName First name": "Klicky", "lastName Last name": "Bot"})
        self.assertIsNone(P.contact_plan(["email", "address1 Street address"], "a.com"))   # no local address configured
        self.assertEqual(P.contact_plan(["name Full name"], "a.com"), [("name Full name", "name", "Klicky Bot")])

    def test_address_from_local_cfg(self):
        P = checkout_probe
        cfg = {"address": {"line1": "1 Example St", "line2": "Unit 2", "city": "Exampleville", "state": "EX", "zip": "00000", "country": "US"}}
        plan = {k: v for f, k, v in P.contact_plan(["address1", "address2 Apartment", "city", "zone State", "postalCode ZIP", "countryCode Country", "phone"], "a.com", cfg)}
        self.assertEqual(plan, {"addr:line1": "1 Example St", "addr:line2": "Unit 2", "addr:city": "Exampleville",
                                "addr:state": "EX", "addr:zip": "00000", "addr:country": "US"})
        self.assertEqual(P.field_kind("phone Phone"), "phone"); self.assertEqual(P.field_kind("cardnumber"), "forbidden")

    def test_no_address_in_code(self):
        d = os.path.dirname(HERE)
        for fn in ("checkout_probe.py", "checkout_parse.py"):
            with open(os.path.join(d, fn)) as f: self.assertNotIn("College Blvd", f.read())
        with open(os.path.join(os.path.dirname(d), ".gitignore")) as f: g = f.read()
        self.assertIn("crawler/probe.local.json", g); self.assertIn("crawler/out/checkout-shots/", g)

if __name__ == "__main__": unittest.main()
