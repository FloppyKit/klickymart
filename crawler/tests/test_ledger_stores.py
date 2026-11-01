import os, sys, tempfile, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hand_anomalies as HA
CRAWLER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = {"author": "kb", "domain": "a.example", "kind": "future_hand_at", "hand_at": "2099-01-01T00:00:00+00:00", "clamped_to": "2026-10-31", "seen_at": "x"}

def test_conftest_hard_sets_env():
    assert os.environ["KM_HAND_ANOMALIES"].startswith(tempfile.gettempdir())

def test_corrupt_line_tolerated_and_counted(tmp_path):
    p = str(tmp_path / "ha.jsonl")
    eid = HA.record(E, path=p)
    with open(p, "a") as f: f.write("{not json\n")
    HA.record(dict(E, domain="b.example"), path=p)
    g = HA.open_by_author(path=p)
    assert sorted(e["domain"] for e in g["kb"]) == ["a.example", "b.example"]
    assert HA.corrupt_lines(path=p) == 1
    HA.clear(eid, "matt", "ok", path=p)

def test_cleared_by_required(tmp_path):
    p = str(tmp_path / "ha.jsonl"); eid = HA.record(E, path=p)
    for bad in ("", "   ", None):
        with pytest.raises(ValueError): HA.clear(eid, bad, "x", path=p)

def test_env_path_validated(tmp_path, monkeypatch):
    monkeypatch.setenv("KM_HAND_ANOMALIES", "/etc/km-hand-anomalies.jsonl")
    with pytest.raises(ValueError, match="KM_HAND_ANOMALIES"): HA.path()
    link = tmp_path / "link.jsonl"; os.symlink("/etc/passwd", link)
    monkeypatch.setenv("KM_HAND_ANOMALIES", str(link))
    with pytest.raises(ValueError): HA.path()
    monkeypatch.setenv("KM_HAND_ANOMALIES", str(tmp_path / "ok.jsonl")); assert HA.path() == str(tmp_path / "ok.jsonl")
    monkeypatch.delenv("KM_HAND_ANOMALIES")
    assert HA.path() == os.path.join(CRAWLER, "out", "hand-anomalies.jsonl")
