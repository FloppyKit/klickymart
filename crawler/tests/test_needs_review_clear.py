import os, sys, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from btc_grade import apply, clear_review
from checkout_parse import merge
URL = "https://s.example/pay"
P0 = {"step_reached": "payment_methods", "methods": [{"c": "card", "ev": "Visa"}], "path": [["p", "https://s.example/c"]]}
def hand(g, **kw):
    r = {"d": "s.example", "btc": g, "btc_src": "hand", "btc_grade_hand_by": "kb", "btc_grade_hand_at": "2026-10-30", "btc_grade_hand_evidence": URL}
    r.update(kw); return r

def test_agreeing_probe_clears_conflict_and_flag_apply():
    flagged = apply(hand(2), P0, today="2026-11-01")
    assert flagged["btc_grade_needs_review"] is True
    agreed = apply(dict(flagged, btc=0), P0, today="2026-11-02")    # hand now agrees with the probe
    assert "btc_grade_conflict" not in agreed and agreed.get("btc_grade_needs_review") is False

def test_agreeing_probe_clears_flag_merge():
    p = {"d": "s.example", "btc_offered": "no", "step_reached": "payment_methods", "methods": [{"c": "card", "ev": "Visa"}]}
    f = merge(hand(3), p, today="2026-11-01"); assert f["btc_grade_needs_review"] is True
    a = merge(dict(f, btc=0), p, today="2026-11-02")
    assert "btc_grade_conflict" not in a and a.get("btc_grade_needs_review") is False

def test_agreement_keeps_flag_when_anomaly_appended_same_pass():
    r = hand(0, btc_grade_hand_at="2026-11-01T12:30:00Z")
    out = apply(r, P0, today="2026-11-01T12:00:00Z")          # agrees (0 == 0) but future hand_at anomaly this pass
    assert out["btc_grade_needs_review"] is True and out["btc_grade_anomalies"]

def test_human_clear_review():
    f = apply(hand(2), P0, today="2026-11-01")
    c = clear_review(f, "matt", "checked store page, hand 2 stands", now="2026-11-01T15:00:00Z")
    assert c["btc_grade_needs_review"] is False
    assert c["btc_grade_review_log"][-1] == {"cleared_by": "matt", "note": "checked store page, hand 2 stands", "at": "2026-11-01T15:00:00+00:00"}
    c2 = clear_review(c, "kb", "again", now="2026-11-02T00:00:00Z"); assert len(c2["btc_grade_review_log"]) == 2
    with pytest.raises(ValueError): clear_review(f, "  ", "x")

def test_crawler_never_calls_clear_review():
    import glob
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hits = [p for p in glob.glob(os.path.join(here, "*.py")) if "clear_review(" in open(p).read() and not p.endswith("btc_grade.py")]
    assert hits == []
