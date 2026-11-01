import json, os, shutil, subprocess, sys, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hand_first_seen as FS
from btc_grade import apply

K = ("s.example", "kb", "2099-01-01")

def test_put_refuses_first_seen_before_past_hand_at(tmp_path):
    p = str(tmp_path / "fs.jsonl")
    with pytest.raises(ValueError): FS.put(("s.example", "kb", "2026-10-01"), "2026-09-01", path=p)
    assert FS.put(("s.example", "kb", "2026-10-01"), "2026-10-01", path=p) == "2026-10-01"

def test_read_ignores_row_before_past_hand_at(tmp_path):
    p = tmp_path / "fs.jsonl"
    p.write_text(json.dumps({"key": list(FS.key("s.example", "kb", "2026-10-01")), "first_seen": "2020-01-01"}) + "\n")
    assert FS.get(("s.example", "kb", "2026-10-01"), path=str(p)) is None

def _repo(tmp_path):
    if not shutil.which("git"): pytest.skip("git unavailable")
    d = tmp_path / "repo"; (d / "data").mkdir(parents=True)
    g = lambda *a, env=None: subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, env=env)
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    return d, g

def test_forged_old_row_in_tracked_file_ignored_review_by_unmoved(tmp_path, monkeypatch):
    d, g = _repo(tmp_path); f = d / "data" / "hand-first-seen.jsonl"
    legit = {"key": list(FS.key(*K)), "first_seen": "2026-10-31"}
    f.write_text(json.dumps(legit) + "\n"); g("add", ".")
    g("commit", "-qm", "legit", env=dict(os.environ, GIT_COMMITTER_DATE="2026-10-31T12:00:00Z", GIT_AUTHOR_DATE="2026-10-31T12:00:00Z"))
    with open(f, "a") as fh: fh.write(json.dumps(dict(legit, first_seen="2020-01-01")) + "\n")
    g("commit", "-qam", "forged")                                   # committed today, claims 2020
    assert FS.get(K, path=str(f)) == "2026-10-31"
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", str(f))
    r = {"d": "s.example", "btc": 0, "btc_src": "hand", "btc_grade_hand_by": "kb", "btc_grade_hand_at": "2099-01-01",
         "btc_grade_hand_evidence": "https://s.example/pay"}
    assert apply(r, today="2026-12-01")["btc_grade_hand_review_by"] == "2027-01-29"

def test_uncommitted_rows_trusted_and_git_missing_graceful(tmp_path, monkeypatch, capsys):
    d, g = _repo(tmp_path); f = d / "data" / "hand-first-seen.jsonl"
    f.write_text(""); g("add", "."); g("commit", "-qm", "empty")
    with open(f, "a") as fh: fh.write(json.dumps({"key": list(FS.key(*K)), "first_seen": "2026-10-31"}) + "\n")
    assert FS.get(K, path=str(f)) == "2026-10-31"                   # not yet committed: operator-local append
    monkeypatch.setattr(FS.shutil, "which", lambda n: None); FS._warned.clear()
    assert FS.get(K, path=str(f)) == "2026-10-31"
    assert "git unavailable" in capsys.readouterr().err
