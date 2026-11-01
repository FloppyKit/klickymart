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
        self.assertEqual(apply({"btc": 4, "btc_src": "hand", "btc_grade_hand_at": "2026-10-30"}, today="2026-11-01")["btc"], 4)   # dated: protected
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

class Hand(unittest.TestCase):
    OBS = {"step_reached": "payment_methods", "methods": [{"c": "btc", "ev": "Bitcoin"}], "processors": []}

    def test_hand_grade_is_never_observed(self):
        from btc_grade import BASIS_HAND, BASIS_OBSERVED
        r = {"btc": 3, "btc_src": "hand", "btc_grade_hand_by": "klickymart", "btc_grade_hand_at": "2026-10-30", "btc_grade_hand_evidence": "https://x.example/pay"}
        for probe in (None, self.OBS):
            g, info = grade_record(r, probe); self.assertEqual(info["basis"], BASIS_HAND); self.assertNotEqual(info["basis"], BASIS_OBSERVED)
            out = apply(r, probe); self.assertEqual(out["btc_grade_basis"], BASIS_HAND); self.assertEqual(out["btc"], 3)
            self.assertEqual(out["btc_grade_hand_evidence"], "https://x.example/pay")

    def test_sort_bound_observed_hand_claimed(self):
        from btc_grade import grade_sort_key as k
        keys = [k(2, "claimed"), k(2, "hand", "https://x.example"), k(2, "observed"), k(2, "bound")]
        self.assertEqual(sorted(keys), [k(2, "bound"), k(2, "observed"), k(2, "hand", "https://x.example"), k(2, "claimed")])

    def test_hand_without_evidence_sorts_with_claimed(self):
        from btc_grade import grade_sort_key as k
        for ev in (None, ""): self.assertEqual(k(2, "hand", ev), k(2, "claimed"))
        self.assertLess(k(2, "hand", "note: phoned store"), k(2, "claimed"))
        r = apply({"btc": 2, "btc_src": "hand", "btc_grade_hand_at": "2026-10-30"}, today="2026-11-01"); self.assertEqual(r["btc_grade_basis"], "hand")

class HandReviewBy(unittest.TestCase):
    URL = "https://x.example/pay"
    PROBE0 = {"step_reached": "payment_methods", "methods": [{"c": "card", "ev": "Visa"}], "path": [["pay", "https://x.example/checkout"]]}
    Q2 = [{"c": "btc", "neg": False, "url": URL, "q": "Pay with bitcoin via OpenNode. Guest checkout, no account needed."}]
    def hand(self, g, **kw):
        r = {"d": "x.example", "btc": g, "btc_src": "hand", "btc_grade_basis": "hand", "btc_grade_hand_by": "kb",
             "btc_grade_hand_at": "2026-10-30", "btc_grade_hand_evidence": self.URL}
        r.update(kw); return r

    def test_review_by_is_hand_at_plus_90(self):
        from btc_grade import hand_review_by
        self.assertEqual(apply(self.hand(2), today="2026-11-01")["btc_grade_hand_review_by"], "2027-01-28")
        self.assertEqual(hand_review_by({"btc_grade_hand_at": "2026-10-30"}), "2027-01-28")

    def test_before_review_downgrade_probe_kept_with_conflict(self):
        out = apply(self.hand(2), self.PROBE0, today="2026-11-15")
        self.assertEqual((out["btc"], out["btc_src"], out["btc_grade_basis"]), (2, "hand", "hand"))
        c = out["btc_grade_conflict"]
        self.assertEqual(c["hand"], {"grade": 2, "basis": "hand"})
        self.assertEqual((c["probe"]["grade"], c["probe"]["basis"], c["probe"]["url"]), (0, "claimed", "https://x.example/checkout"))
        self.assertEqual(c["seen_at"], "2026-11-15")

    def test_before_review_upgrade_probe_kept_with_conflict(self):
        out = apply(self.hand(0, pay_q=self.Q2), today="2026-11-15")
        self.assertEqual((out["btc"], out["btc_src"]), (0, "hand"))
        self.assertEqual(out["btc_grade_conflict"]["probe"]["grade"], 2)
        self.assertEqual(out["btc_grade_conflict"]["probe"]["url"], self.URL)

    def test_before_review_agreeing_probe_no_conflict(self):
        self.assertNotIn("btc_grade_conflict", apply(self.hand(0), self.PROBE0, today="2026-11-15"))
        self.assertNotIn("btc_grade_conflict", apply(self.hand(2, pay_q=self.Q2), today="2026-11-15"))

    def test_on_or_after_review_probe_overwrites(self):
        for today in ("2027-01-28", "2027-03-01"):
            down = apply(self.hand(2), self.PROBE0, today=today)
            self.assertEqual((down["btc"], down["btc_src"], down["btc_grade_basis"]), (0, "agent-evidence", "claimed"))
            self.assertNotIn("btc_grade_conflict", down)
            up = apply(self.hand(0, pay_q=self.Q2), today=today)
            self.assertEqual((up["btc"], up["btc_src"]), (2, "agent-evidence"))
        self.assertEqual(apply(self.hand(2), self.PROBE0, today="2027-01-27")["btc"], 2)   # day before: still hand

class HandReviewByMerge(unittest.TestCase):
    def setUp(self):
        from checkout_parse import merge, grade
        self.merge, self.grade = merge, grade
    def probe(self, btc):
        p = {"d": "x.example", "step_reached": "payment_methods", "btc_offered": "yes" if btc else "no",
             "methods": [{"c": "btc", "ev": "Bitcoin"}] if btc else [{"c": "card", "ev": "Visa"}],
             "processors": [], "privacy": ["noacct", "selfhosted"] if btc else [], "path": [["pay", "https://x.example/checkout"]]}
        return p
    def test_merge_symmetric(self):
        for hand_g, p in ((3, self.probe(False)), (0, self.probe(True))):
            g = self.grade(p)
            self.assertNotIn(g, (None, hand_g))
            r = {"d": "x.example", "btc": hand_g, "btc_src": "hand", "btc_grade_hand_at": "2026-10-30"}
            kept = self.merge(r, p, today="2026-12-01")
            self.assertEqual((kept["btc"], kept["btc_src"]), (hand_g, "hand"))
            self.assertEqual(kept["btc_grade_conflict"]["probe"]["grade"], g)
            self.assertEqual(kept["btc_grade_hand_review_by"], "2027-01-28")
            over = self.merge(r, p, today="2027-01-28")
            self.assertEqual((over["btc"], over["btc_src"]), (g, "checkout-probe"))
            self.assertNotIn("btc_grade_conflict", over)

class UndatedHandFailsOpen(unittest.TestCase):
    PROBE0 = HandReviewBy.PROBE0
    def undated(self, g):
        return {"d": "x.example", "btc": g, "btc_src": "hand", "btc_grade_basis": "hand", "btc_grade_hand_evidence": "https://x.example/pay"}
    def test_undated_disagreeing_probe_overwrites_and_keeps_old_hand(self):
        from btc_grade import hand_protected
        self.assertFalse(hand_protected(self.undated(2), today="2026-11-01"))
        out = apply(self.undated(2), self.PROBE0, today="2026-11-01")
        self.assertEqual((out["btc"], out["btc_src"], out["btc_grade_basis"]), (0, "agent-evidence", "claimed"))
        c = out["btc_grade_conflict"]
        self.assertEqual(c["hand"], {"grade": 2, "basis": "hand"})
        self.assertEqual((c["probe"]["grade"], c["probe"]["url"], c["seen_at"]), (0, "https://x.example/checkout", "2026-11-01"))
    def test_undated_agreeing_probe_no_conflict(self):
        out = apply(self.undated(0), self.PROBE0, today="2026-11-01")
        self.assertEqual(out["btc"], 0); self.assertNotIn("btc_grade_conflict", out)
    def test_undated_merge_fails_open(self):
        from checkout_parse import merge
        p = HandReviewByMerge().probe(False)
        out = merge({"d": "x.example", "btc": 3, "btc_src": "hand"}, p, today="2026-11-01")
        self.assertEqual((out["btc"], out["btc_src"]), (0, "checkout-probe"))
        self.assertEqual(out["btc_grade_conflict"]["hand"], {"grade": 3, "basis": "hand"})
        self.assertNotIn("btc_grade_conflict", merge({"d": "x.example", "btc": 0, "btc_src": "hand"}, p, today="2026-11-01"))

class ValidateHandOverride(unittest.TestCase):
    OK = {"btc": 0, "btc_src": "hand", "btc_grade_hand_at": "2026-10-30", "btc_grade_hand_evidence": "https://x.example/pay"}
    def test_validator(self):
        from btc_grade import validate_hand_override
        validate_hand_override(self.OK)
        validate_hand_override(dict(self.OK, btc_grade_hand_evidence=["https://a.example/1", "https://b.example/2"]))
        for bad in ({"btc_grade_hand_at": None}, {"btc_grade_hand_at": "soon"}, {"btc_grade_hand_evidence": None},
                    {"btc_grade_hand_evidence": ""}, {"btc_grade_hand_evidence": "a note"}, {"btc_grade_hand_evidence": []}):
            with self.assertRaises(ValueError, msg=bad): validate_hand_override(dict(self.OK, **bad))
    def test_existing_build_v4_overrides_pass(self):
        from btc_grade import validate_hand_override
        for ev in ("https://www.bestbuy.com/site/help-topics/payment-options/pcmcat203400050003.c?id=pcmcat203400050003",
                   "https://www.sonos.com/pdfs/policies/2024-11-terms-of-sale-en-us.pdf"):
            validate_hand_override(dict(self.OK, btc_grade_hand_evidence=ev))
    def test_build_v4_writer_skips_invalid_without_raising(self):
        from btc_grade import write_hand_override
        logs = []; r = {"d": "x.example", "btc": 2, "btc_src": "agent-evidence"}
        self.assertFalse(write_hand_override(r, log=logs.append, btc=0, btc_grade_hand_by="kb", btc_grade_hand_evidence="https://x.example/pay"))
        self.assertEqual(r, {"d": "x.example", "btc": 2, "btc_src": "agent-evidence"})
        self.assertIn("hand override skipped", logs[0])
        self.assertTrue(write_hand_override(r, log=logs.append, btc=0, btc_grade_hand_at="2026-10-30", btc_grade_hand_evidence="https://x.example/pay"))
        self.assertEqual((r["btc"], r["btc_src"], r["btc_grade_basis"], r["btc_grade_hand_review_by"]), (0, "hand", "hand", "2027-01-28"))

if __name__ == "__main__": unittest.main()
