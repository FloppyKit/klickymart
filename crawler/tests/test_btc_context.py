import os, sys, unittest
HERE = os.path.dirname(__file__); sys.path.insert(0, os.path.dirname(HERE))
from extract import extract_payments, btc_payment_context
FAQ = "https://s.example/faq/payment"
def ex(line, url=FAQ, step="help"): return extract_payments([(url, step, "Site", line)])

def pay(line, step="home", url="https://site.example/"):
    return extract_payments([(url, step, "Site", line)])[0]

class BtcContext(unittest.TestCase):
    def test_editorial_rejected(self):   # real false positives from the full crawl
        for l in ["Galaxy Asset Management: “Now Is The Time” to Buy Bitcoin",
                  "US customers can now earn 3.6% interest on cash, paid in bitcoin.",
                  "Buy and sell bitcoin for fiat (or other cryptocurrencies) privately and securely using Bisq",
                  "pay bills with any balance, including with a bitcoin-backed line of credit",
                  "Does Amazon.com accept Bitcoin or crypto?",
                  "The Lightning Network is a Layer 2 protocol for Bitcoin, specifically designed for cheap, fast payments"]:
            self.assertFalse({"btc", "ln"} & set(pay(l)), l)
        self.assertFalse({"btc", "ln"} & set(pay("The Lightning Network is a Layer 2 protocol for Bitcoin, designed for fast payments",
                                                  "help", "https://bitcoinmagazine.com/bitcoin-glossary")))

    def test_acceptance_kept(self):
        self.assertIn("btc", pay("Buy Gift Cards With Bitcoin."))
        self.assertIn("btc", pay("Buy prepaid Visa and Mastercards with bitcoin and stablecoins and spend them almost anywhere"))
        self.assertIn("ln", pay("At checkout you can pay with Lightning or on-chain bitcoin."))
        self.assertIn("btc", pay("We accept Bitcoin, Visa and Mastercard for all orders."))

    def test_footer_badge(self):
        self.assertTrue(btc_payment_context("Bitcoin accepted here", False))
        self.assertTrue(btc_payment_context("Lightning accepted", False))
        self.assertIn("btc", pay("Bitcoin accepted here"))

    def test_faq_payment_page(self):
        self.assertIn("btc", pay("Which payment methods do you take? Card, PayPal and Bitcoin are available.", "help", "https://s.example/faq/payment"))
        self.assertFalse(btc_payment_context("BITCOIN", True))

    def test_editorial_line_does_not_borrow(self):   # payment word elsewhere on the line, not in a preceding question
        for l in ["Buy Bitcoin today. We accept card and PayPal at checkout.",
                  "We accept card and PayPal at checkout. Bitcoin is the future of money."]:
            self.assertNotIn("btc", pay(l, "help", "https://s.example/faq/payment"), l)

    def test_question_without_ctx_does_not_lend(self):
        l = "What is your favourite coin? Bitcoin is available."
        self.assertNotIn("btc", pay(l, "help", "https://s.example/faq/payment"))
        # same answer after a CTX question does borrow
        self.assertIn("btc", pay("Which payment methods do you take? Bitcoin is available.", "help", "https://s.example/faq/payment"))

    # P2-5 (Satoshi 2026-10-31)
    def test_p2_5_ctx_question_does_not_launder_unrelated_btc(self):
        r = ex("Do you accept payment by card? We love Bitcoin memes.")
        self.assertNotIn("btc", r[0]); self.assertFalse([q for q in r[2] if q["c"] == "btc"])
        self.assertIn("btc", pay("Which payment methods do you take? Card, PayPal and Bitcoin are available.", "help", FAQ))

    def test_p2_5_scoped_exception_keeps_positive(self):
        r = ex("Payment: Visa, Mastercard, Bitcoin (not accepted for gift cards).")
        self.assertIn("btc", r[0]); self.assertNotIn("btc", r[1])
        q = [q for q in r[2] if q["c"] == "btc"][0]
        self.assertFalse(q["neg"]); self.assertEqual(q.get("scope_note"), "not accepted for gift cards")

    def test_p2_5_plain_negation_is_negative(self):
        r = ex("Bitcoin is not accepted.")
        self.assertNotIn("btc", r[0]); self.assertIn("btc", r[1])

if __name__ == "__main__": unittest.main()
