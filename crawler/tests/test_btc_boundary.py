"""Pins the BTC payment-evidence boundary (spec v9.2 s1): current behavior for four store-name-free cases,
and that every BTC quote is store-asserted with url + quote + snapshot_id."""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from extract import extract_payments, BTC_STRICT

def run(url, step, title, text):
    return extract_payments([(url, step, title, text)])

class T(unittest.TestCase):
    def assert_provenance(self, quotes, url):
        for q in quotes:
            if q["c"] in BTC_STRICT:
                self.assertEqual(q["provenance"], "store-asserted")
                self.assertEqual(q["url"], url); self.assertTrue(q["q"]); self.assertIn("snapshot_id", q)
                self.assertIsNone(q["snapshot_id"])

    def test_1_badge_on_non_payment_page_counts(self):
        u = "https://shop.example/products/widget"
        pay, no, q = run(u, "pdp", "Widget", "Widget\nBitcoin accepted\nAdd to cart")
        self.assertEqual(pay, ["btc"]); self.assertEqual(no, [])
        self.assertEqual([x["q"] for x in q], ["Bitcoin accepted"]); self.assertEqual(q[0]["conf"], "low")
        self.assert_provenance(q, u)

    def test_2_payment_method_table_row_counts(self):
        u = "https://shop.example/help/payment-methods"
        pay, no, q = run(u, "help", "Payment methods", "## Payment methods\nBitcoin BTC Bitcoin Network, Lightning Network")
        self.assertEqual(pay, ["btc", "ln"]); self.assertEqual(no, [])
        self.assertTrue(all(x["conf"] == "med" for x in q))
        self.assert_provenance(q, u)

    def test_3_faq_does_x_accept_bitcoin_is_not_evidence(self):
        u = "https://shop.example/help/faq"
        pay, no, q = run(u, "help", "FAQ", "Does Example accept bitcoin?")
        self.assertEqual((pay, no, q), ([], [], []))
        # current gap: NOT_PAYMENT_RX matches only a one-word name, so a multi-word subject reads as acceptance
        pay, no, q = run(u, "help", "FAQ", "Does the shop accept bitcoin?")
        self.assertEqual(pay, ["btc"]); self.assertEqual(q[0]["conf"], "med"); self.assert_provenance(q, u)

    def test_4_bitcoin_backed_loan_page_is_not_evidence(self):
        u = "https://lender.example/help/bitcoin-loans"
        pay, no, q = run(u, "help", "Bitcoin-backed loans | Pay interest",
                         "Get a bitcoin-backed loan and pay interest monthly.\nEarn interest on your bitcoin.")
        self.assertEqual((pay, no, q), ([], [], []))

    def test_non_btc_quotes_have_no_provenance_field(self):
        pay, _, q = run("https://shop.example/help/payment", "help", "Payment", "We accept Visa and PayPal.")
        self.assertEqual(pay, ["card", "pp"]); self.assertTrue(all("provenance" not in x for x in q))

if __name__ == "__main__": unittest.main()
