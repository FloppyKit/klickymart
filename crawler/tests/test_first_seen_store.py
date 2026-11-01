import os, sys, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hand_first_seen as FS
from btc_grade import apply, hand_review_by

def rec(**kw):
    r = {"d": "s.example", "btc": 0, "btc_src": "hand", "btc_grade_hand_by": "kb", "btc_grade_hand_at": "2099-01-01",
         "btc_grade_hand_evidence": "https://s.example/pay"}
    r.update(kw); return r

def test_audit_repro_rebuild_without_field_keeps_review_by():
    first = apply(rec(), today="2026-10-31")
    assert first["btc_grade_hand_review_by"] == "2027-01-29"
    rebuilt = apply(rec(), today="2027-03-01")          # source record never had btc_grade_hand_first_seen
    assert rebuilt["btc_grade_hand_first_seen"] == "2026-10-31"
    assert rebuilt["btc_grade_hand_review_by"] == "2027-01-29"

def test_undated_rebuild_keeps_first_seen():
    r = rec(); r.pop("btc_grade_hand_at")
    apply(r, today="2026-11-01")
    assert apply(dict(r), today="2027-06-01")["btc_grade_hand_first_seen"] == "2026-11-01"

def test_store_min_never_max(tmp_path):
    p = str(tmp_path / "fs.jsonl"); k = ("a.example", "kb", "2099-01-01T00:00:00+00:00")
    assert FS.put(k, "2026-11-05", path=p) == "2026-11-05"
    assert FS.put(k, "2026-12-01", path=p) == "2026-11-05"   # later write keeps earliest
    assert FS.put(k, "2026-10-01", path=p) == "2026-10-01"   # earlier moves it back
    assert FS.get(k, path=p) == "2026-10-01"

def test_key_normalizes_hand_at():
    assert FS.key("a.example", "kb", "2099-01-01") == FS.key("a.example", "kb", "2099-01-01T00:00:00Z") == FS.key("a.example", "kb", "2098-12-31T19:00:00-05:00")

def test_store_tolerates_corrupt_and_validates_env(tmp_path, monkeypatch):
    p = str(tmp_path / "fs.jsonl"); k = ("a.example", "kb", "")
    FS.put(k, "2026-11-05", path=p)
    with open(p, "a") as f: f.write("garbage\n")
    assert FS.get(k, path=p) == "2026-11-05" and FS.corrupt_lines(path=p) == 1
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", "/var/km-fs.jsonl")
    with pytest.raises(ValueError, match="KM_HAND_FIRST_SEEN"): FS.path()
