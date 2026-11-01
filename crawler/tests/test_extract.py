"""Run: cd crawler && .venv/bin/python -m unittest discover -s tests -v"""
import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
from extract import extract_payments, scope_split, ugc_mask
def fx(n):
    with open(os.path.join(HERE, "fixtures", n)) as f: return f.read()

class UGCFilter(unittest.TestCase):
    def test_review_cards_yield_nothing(self):
        # synthetic review-card block: reviews mention a Visa card and crypto payments
        pay, no, q = extract_payments([("https://shop.example/", "home", "Shop", fx("review_cards.txt"))])
        self.assertEqual(pay, [], q); self.assertEqual(no, [])

    def test_review_and_qa_sections_ignored_merchant_text_kept(self):
        pay, no, q = extract_payments([("https://shop.example/pdp", "pdp", "Echo", fx("pdp_with_reviews.txt"))])
        self.assertNotIn("btc", pay); self.assertNotIn("pp", pay); self.assertNotIn("venmo", pay + no)
        self.assertIn("card", pay)          # merchant line before the review section
        self.assertIn("apay", pay)          # merchant line after a new '## ' heading closes the review window
        for x in q: self.assertNotRegex(x["q"], r"(?i)\bI (paid|used)\b")

    def test_marked_dom_ugc_ignored(self):
        pay, no, q = extract_payments([("https://shop.example/", "home", "Shop", fx("marked_ugc.txt"))])
        self.assertEqual(pay, ["btc"]); self.assertNotIn("xmr", pay + no); self.assertNotIn("ln", pay)

    def test_first_person_on_payment_page_not_dropped(self):
        # merchant policy pages may say 'my account'; payment pages keep first-person lines
        m = ugc_mask(["Go to My Account to change how you pay with Visa."], paypage=True)
        self.assertEqual(m, [False])

class Scope(unittest.TestCase):
    def setUp(self):
        self.pay, self.no, self.q = extract_payments([("https://shop.example/help/payment", "help", "Payment options", fx("scoped_help.txt"))])
        self.on, self.st, self.un = scope_split(self.q)

    def test_every_quote_has_scope_key_url_and_quote(self):
        for x in self.q:
            self.assertIn("scope", x); self.assertTrue(x["url"].startswith("https://")); self.assertTrue(x["q"])

    def test_split(self):
        self.assertIn("card", self.on); self.assertIn("pp", self.on); self.assertIn("ebt", self.on)
        self.assertIn("apay", self.st); self.assertIn("gpay", self.st)
        self.assertNotIn("apay", self.on)
        self.assertIn("gift", self.on); self.assertIn("gift", self.st)   # 'online and in stores' -> both
        self.assertIn("venmo", self.no)

    def test_unstated_scope_stays_null(self):
        pay, no, q = extract_payments([("https://x.example/faq", "help", "FAQ", "We accept PayPal for all orders.")])
        self.assertEqual([x["scope"] for x in q], [None])
        self.assertEqual(scope_split(q), ([], [], ["pp"]))

if __name__ == "__main__": unittest.main()


def test_paypage_table_row_lightning_network():
    from extract import extract_payments
    t = "Name Code Network(s)\nBitcoin BTC Bitcoin Network, Lightning Network\nLitecoin LTC Litecoin"
    pay, no, q = extract_payments([("https://help.example.com/hc/en-us/articles/1-What-can-I-pay-with", "help", "What can I pay with", t)])
    assert "ln" in pay and "btc" in pay


def test_non_paypage_lightning_row_still_needs_context():
    from extract import extract_payments
    pay, _, _ = extract_payments([("https://example.com/blog/news", "home", "News", "Lightning Network")])
    assert "ln" not in pay
