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
                self.assertRegex(q["evidence_sha"], r"^[0-9a-f]{64}$"); self.assertRegex(q["fetched_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

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
        # FAQ gap closed: a segment ending in '?' is never BTC evidence, whatever the subject
        pay, no, q = run(u, "help", "FAQ", "Does the shop accept bitcoin?")
        self.assertEqual((pay, no, q), ([], [], []))

    def test_3b_faq_question_plus_answer_counts_once_from_answer(self):
        u = "https://shop.example/help/faq"
        pay, no, q = run(u, "help", "FAQ", "Does the shop accept bitcoin? Yes, we accept bitcoin.")
        self.assertEqual(pay, ["btc"]); self.assertEqual(len(q), 1)
        self.assertEqual(q[0]["q"], "Yes, we accept bitcoin."); self.assert_provenance(q, u)

    def test_3c_faq_question_answer_same_line_named_store(self):
        u = "https://shop.example/help/faq"
        pay, no, q = run(u, "help", "FAQ", "Does Example accept bitcoin? Yes, we accept bitcoin.")
        self.assertEqual(pay, ["btc"]); self.assertEqual(no, []); self.assertEqual([x["q"] for x in q], ["Yes, we accept bitcoin."])
        self.assert_provenance(q, u)

    def test_3d_faq_question_answer_same_line_the_shop(self):
        u = "https://shop.example/help/faq"
        pay, no, q = run(u, "help", "FAQ", "Does the shop accept bitcoin? Yes, we accept bitcoin.")
        self.assertEqual(pay, ["btc"]); self.assertEqual(no, []); self.assertEqual([x["q"] for x in q], ["Yes, we accept bitcoin."])
        self.assert_provenance(q, u)

    def test_4_bitcoin_backed_loan_page_is_not_evidence(self):
        u = "https://lender.example/help/bitcoin-loans"
        pay, no, q = run(u, "help", "Bitcoin-backed loans | Pay interest",
                         "Get a bitcoin-backed loan and pay interest monthly.\nEarn interest on your bitcoin.")
        self.assertEqual((pay, no, q), ([], [], []))

    def test_non_btc_quotes_have_no_provenance_field(self):
        pay, _, q = run("https://shop.example/help/payment", "help", "Payment", "We accept Visa and PayPal.")
        self.assertEqual(pay, ["card", "pp"]); self.assertTrue(all("provenance" not in x for x in q))

class Evidence(unittest.TestCase):
    def test_same_text_same_sha_and_normalization(self):
        from extract import evidence_sha, normalize_text
        a = "Bitcoin  accepted\n\n Add to cart "
        self.assertEqual(evidence_sha(a), evidence_sha(a))
        self.assertEqual(evidence_sha(a), evidence_sha("Bitcoin accepted Add to cart"))
        self.assertEqual(normalize_text("Cafe\u0301\t x"), "Caf\u00e9 x")   # NFC + whitespace collapse
        self.assertNotEqual(evidence_sha(a), evidence_sha("Bitcoin accepted"))
    def test_quote_is_substring_of_stored_blob(self):
        import tempfile, hashlib
        d = tempfile.mkdtemp()
        txt = "Widget\n\n  Pay  with   bitcoin\tor lightning at checkout today.\nAdd to cart"
        _, _, q = extract_payments([("https://shop.example/p", "pdp", "Widget", txt, "2026-10-31T12:00:00Z")], evidence_dir=d)
        btc = [x for x in q if x["c"] in BTC_STRICT]; self.assertTrue(btc)
        for x in btc:
            blob = open(os.path.join(d, x["evidence_sha"] + ".txt"), encoding="utf-8").read()
            self.assertEqual(hashlib.sha256(blob.encode("utf-8")).hexdigest(), x["evidence_sha"])
            self.assertIn(x["q"], blob); self.assertEqual(x["fetched_at"], "2026-10-31T12:00:00Z"); self.assertEqual(x["url"], "https://shop.example/p")
        self.assertEqual(os.listdir(d), [btc[0]["evidence_sha"] + ".txt"])

if __name__ == "__main__": unittest.main()
