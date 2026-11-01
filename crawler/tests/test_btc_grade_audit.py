import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from btc_grade import grade_record, apply, probe_observed

FAQ = [{"c": "btc", "neg": False, "url": "https://s.example/faq", "conf": "med", "scope": "online",
        "q": "Pay with bitcoin on our own BTCPay node, checkout without an account, no KYC."}]
CARD_ONLY = {"step_reached": "payment_methods", "methods": [{"c": "card", "ev": "Visa"}], "processors": [],
             "path": [["pay", "https://s.example/checkout"]]}

class P1_2CardOnlyProbeNotObserved(unittest.TestCase):
    def test_card_only_probe_is_not_observed(self):
        self.assertFalse(probe_observed(CARD_ONLY))
        self.assertTrue(probe_observed(dict(CARD_ONLY, methods=[{"c": "btc", "ev": "Bitcoin"}])))
    def test_faq_plus_card_only_probe_same_as_no_probe(self):
        g0, i0 = grade_record({"pay_q": FAQ})
        g1, i1 = grade_record({"pay_q": FAQ}, CARD_ONLY)
        self.assertEqual((g1, i1.get("range"), i1["basis"]), (None, "3-4 claimed", "claimed"))
        self.assertEqual((g0, i0.get("range")), (g1, i1.get("range")))
    def test_card_only_probe_cannot_lift_over_hand_after_review(self):
        hand = {"d": "s.example", "btc": 0, "btc_src": "hand", "btc_grade_hand_at": "2026-01-01",
                "btc_grade_hand_evidence": "https://s.example/pay", "pay_q": FAQ}
        out = apply(hand, CARD_ONLY, today="2026-10-31")   # after review_by
        self.assertNotIn(out["btc"], (3, 4)); self.assertNotEqual(out.get("btc_grade_basis"), "observed")

if __name__ == "__main__": unittest.main()
