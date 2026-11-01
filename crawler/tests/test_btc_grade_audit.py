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

def hand(g, **kw):
    r = {"d": "s.example", "btc": g, "btc_src": "hand", "btc_grade_hand_at": "2026-01-01", "btc_grade_hand_evidence": "https://s.example/pay"}
    r.update(kw); return r
INCONCLUSIVE = {"step_reached": "cart", "methods": [], "processors": []}

class P2_aInconclusiveNeverErasesHand(unittest.TestCase):
    def test_dated_after_review_none_keeps_hand(self):
        prior = {"hand": {"grade": 2, "basis": "hand"}, "probe": {"grade": 0}, "seen_at": "2026-02-01"}
        out = apply(hand(2, btc_grade_conflict=prior), INCONCLUSIVE, today="2026-10-31")
        self.assertEqual((out["btc"], out["btc_src"]), (2, "hand")); self.assertEqual(out["btc_grade_conflict"], prior)
    def test_undated_after_review_none_keeps_hand(self):
        r = hand(3, btc_grade_hand_first_seen="2026-01-01"); r.pop("btc_grade_hand_at")
        out = apply(r, None, today="2026-10-31")
        self.assertEqual((out["btc"], out["btc_src"]), (3, "hand"))

class P2_6UtcDates(unittest.TestCase):
    def test_offset_kept_not_truncated(self):
        from btc_grade import _date
        import datetime
        self.assertEqual(_date("2026-10-31T23:30:00-05:00"), datetime.date(2026, 11, 1))   # UTC date, not the local [:10]
        self.assertEqual(_date("2026-10-31T01:00:00Z"), datetime.date(2026, 10, 31))
        self.assertEqual(_date("2026-10-31"), datetime.date(2026, 10, 31))
    def test_future_hand_at_clamped(self):
        from btc_grade import hand_review_by, hand_protected
        r = hand(2, btc_grade_hand_at="2099-01-01")
        self.assertEqual(hand_review_by(r, today="2026-10-31"), "2027-01-29")
        seen = apply(r, today="2026-10-31")   # first pass persists the clamp
        self.assertEqual(seen["btc_grade_hand_first_seen"], "2026-10-31")
        self.assertTrue(hand_protected(seen, today="2027-01-28"))
        self.assertFalse(hand_protected(seen, today="2027-01-29"))
    def test_default_today_is_utc(self):
        import btc_grade, datetime
        self.assertEqual(btc_grade._today(), datetime.datetime.now(datetime.timezone.utc).date())

class P2_bFutureHandAtRefused(unittest.TestCase):
    def test_validator_refuses_future(self):
        from btc_grade import validate_hand_override, write_hand_override
        with self.assertRaises(ValueError): validate_hand_override(hand(0, btc_grade_hand_at="2026-11-02"), today="2026-11-01")
        validate_hand_override(hand(0, btc_grade_hand_at="2026-11-01"), today="2026-11-01")
        logs = []; r = {"d": "s.example"}
        self.assertFalse(write_hand_override(r, log=logs.append, today="2026-11-01", btc=0, btc_grade_hand_at="2099-01-01",
                                             btc_grade_hand_evidence="https://s.example/pay"))
        self.assertIn("future", logs[0])

class P2_7ConflictUrlRedacted(unittest.TestCase):
    def test_probe_url_redacted(self):
        p = dict(CARD_ONLY, path=[["pay", "https://user:pw@s.example/checkout/abc?token=SECRETtok&macaroon=MACx"]])
        out = apply(hand(2, btc_grade_hand_at="2026-10-30"), p, today="2026-11-01")
        u = out["btc_grade_conflict"]["probe"]["url"]
        self.assertTrue(u.startswith("https://s.example/checkout")); self.assertNotIn("?", u)
        for bad in ("SECRETtok", "MACx", "user:pw"): self.assertNotIn(bad, u)

class NeedsReviewAndSkew(unittest.TestCase):
    def test_dated_conflict_sets_flag(self):
        out = apply(hand(2, btc_grade_hand_at="2026-10-30"), CARD_ONLY, today="2026-11-01")
        self.assertIn("btc_grade_conflict", out); self.assertIs(out["btc_grade_needs_review"], True)
        from checkout_parse import merge
        p = {"d": "s.example", "step_reached": "payment_methods", "btc_offered": "no", "methods": [{"c": "card", "ev": "Visa"}], "path": [["p", "https://s.example/c"]]}
        m = merge(hand(3, btc_grade_hand_at="2026-10-30"), p, today="2026-11-01")
        self.assertIn("btc_grade_conflict", m); self.assertIs(m["btc_grade_needs_review"], True)
    def test_future_hand_at_beyond_skew_anomaly(self):
        out = apply(hand(0, btc_grade_hand_at="2026-11-01T12:30:00Z"), today="2026-11-01T12:00:00Z")
        a = out["btc_grade_anomaly"]
        self.assertEqual((a["kind"], a["hand_at"], a["clamped_to"]), ("future_hand_at", "2026-11-01T12:30:00Z", out["btc_grade_hand_first_seen"]))
        self.assertTrue(a["seen_at"]); self.assertIs(out["btc_grade_needs_review"], True)
    def test_hand_at_within_skew_no_anomaly(self):
        out = apply(hand(0, btc_grade_hand_at="2026-11-01T12:09:00Z"), today="2026-11-01T12:00:00Z")
        self.assertNotIn("btc_grade_anomaly", out); self.assertNotIn("btc_grade_needs_review", out)

if __name__ == "__main__": unittest.main()
