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
    g("commit", "-qam", "forged")                                   # committed today, claims 2020 -> clamped to today
    assert FS.get(K, path=str(f)) == "2026-10-31"
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", str(f))
    r = {"d": "s.example", "btc": 0, "btc_src": "hand", "btc_grade_hand_by": "kb", "btc_grade_hand_at": "2099-01-01",
         "btc_grade_hand_evidence": "https://s.example/pay"}
    assert apply(r, today="2026-12-01")["btc_grade_hand_review_by"] == "2027-01-29"

def _commit(g, msg, date):
    g("commit", "-qam", msg, env=dict(os.environ, GIT_COMMITTER_DATE=date, GIT_AUTHOR_DATE=date))   # test fixture only

def test_uncommitted_rows_excluded_unless_allowed(tmp_path):
    d, g = _repo(tmp_path); f = d / "data" / "hand-first-seen.jsonl"
    f.write_text(""); g("add", "."); g("commit", "-qm", "empty")
    with open(f, "a") as fh: fh.write(json.dumps({"key": list(FS.key(*K)), "first_seen": "2026-10-31"}) + "\n")
    assert FS.get(K, path=str(f)) is None                               # r5-2: uncommitted rows don't count
    assert FS.get(K, path=str(f), allow_uncommitted=True) == "2026-10-31"

def test_tracked_data_file_fails_closed_without_git(monkeypatch):
    monkeypatch.delenv("KM_HAND_FIRST_SEEN")
    monkeypatch.setattr(FS.shutil, "which", lambda n: None)
    with pytest.raises(FS.LedgerTrustError): FS.get(K)                  # default path = tracked data/ file

def test_tracked_data_file_fails_closed_when_blame_fails(monkeypatch):
    monkeypatch.delenv("KM_HAND_FIRST_SEEN")
    real = FS.subprocess.run
    def fake(cmd, *a, **k):
        if "blame" in cmd: return real(["false"], *a, **k)
        return real(cmd, *a, **k)
    monkeypatch.setattr(FS.subprocess, "run", fake)
    if not os.path.getsize(FS.path()):
        with open(FS.path()) as _: pass
    with pytest.raises(FS.LedgerTrustError): FS._commit_dates(FS.path())

def test_tmp_untracked_file_exempt_warns(tmp_path, monkeypatch, capsys):
    p = tmp_path / "fs.jsonl"; p.write_text(json.dumps({"key": list(FS.key(*K)), "first_seen": "2026-10-31"}) + "\n")
    monkeypatch.setattr(FS.shutil, "which", lambda n: None); FS._warned.clear()
    assert FS.get(K, path=str(p)) == "2026-10-31"
    assert "git unavailable" in capsys.readouterr().err

def test_r5_3_late_commit_clamped_and_anomaly(tmp_path, monkeypatch):
    import hand_anomalies as HA
    d, g = _repo(tmp_path); f = d / "data" / "hand-first-seen.jsonl"
    f.write_text(""); g("add", "."); g("commit", "-qm", "empty")
    with open(f, "a") as fh: fh.write(json.dumps({"key": list(FS.key(*K)), "first_seen": "2026-10-31"}) + "\n")
    _commit(g, "late", "2026-11-03T12:00:00Z")
    assert FS.get(K, path=str(f)) == "2026-11-03"                       # clamped, not dropped
    det = FS.get_detail(K, path=str(f))
    assert (det["first_seen_written"], det["first_seen_effective"], det["committed_at"]) == ("2026-10-31", "2026-11-03", "2026-11-03")
    FS.get(K, path=str(f))                                              # second read: no duplicate anomaly
    late = [e for es in HA.open_by_author().values() for e in es if e["kind"] == "late_commit"]
    assert len(late) == 1 and late[0]["author"] == "kb" and late[0]["domain"] == "s.example"
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", str(f))
    r = {"d": "s.example", "btc": 0, "btc_src": "hand", "btc_grade_hand_by": "kb", "btc_grade_hand_at": "2099-01-01",
         "btc_grade_hand_evidence": "https://s.example/pay"}
    assert apply(r, today="2026-11-05")["btc_grade_hand_review_by"] == "2027-02-01"   # 11-03 + 90d

def test_same_day_commit_no_late_anomaly(tmp_path):
    import hand_anomalies as HA
    d, g = _repo(tmp_path); f = d / "data" / "hand-first-seen.jsonl"
    f.write_text(""); g("add", "."); g("commit", "-qm", "empty")
    with open(f, "a") as fh: fh.write(json.dumps({"key": list(FS.key(*K)), "first_seen": "2026-10-31"}) + "\n")
    _commit(g, "same day", "2026-10-31T23:00:00Z")
    assert FS.get(K, path=str(f)) == "2026-10-31"
    assert not [e for es in HA.open_by_author().values() for e in es if e["kind"] == "late_commit"]
