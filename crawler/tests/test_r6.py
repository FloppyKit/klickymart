import json, os, shutil, subprocess, sys, pytest
CRAWLER = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, CRAWLER)
REPO = os.path.dirname(CRAWLER)
import hand_first_seen as FS, hand_anomalies as HA, ledger_commit as LC
K = ("s.example", "kb", "2099-01-01")

@pytest.fixture
def repo(tmp_path, monkeypatch):
    if not shutil.which("git"): pytest.skip("git unavailable")
    d = tmp_path / "repo"; (d / "data").mkdir(parents=True)
    def g(*a, env=None): return subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, text=True, env=env).stdout
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    for n in ("hand-first-seen.jsonl", "hand-anomalies.jsonl"): (d / "data" / n).write_text("")
    g("add", "."); g("commit", "-qm", "base")
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", str(d / "data" / "hand-first-seen.jsonl"))
    monkeypatch.setenv("KM_HAND_ANOMALIES", str(d / "data" / "hand-anomalies.jsonl"))
    monkeypatch.setenv("KM_LEDGER_AUTOCOMMIT", "1")
    return d, g

def _late_row(d, g):
    f = d / "data" / "hand-first-seen.jsonl"
    with open(f, "a") as fh: fh.write(json.dumps({"key": list(FS.key(*K)), "first_seen": "2026-10-31"}) + "\n")
    date = "2026-11-03T12:00:00Z"   # test fixture only: simulate a late commit
    g("commit", "-qam", "late", env=dict(os.environ, GIT_COMMITTER_DATE=date, GIT_AUTHOR_DATE=date))

def test_r6_1_get_outside_pass_has_no_side_effects(repo):
    d, g = repo; _late_row(d, g)
    ha = d / "data" / "hand-anomalies.jsonl"; before = ha.read_bytes()
    det = FS.get_detail(K); assert det["first_seen_effective"] == "2026-11-03" and det["late"] is True
    FS.get(K); assert ha.read_bytes() == before                         # read-only outside a pass
    with LC.ledger_pass():                                              # the pass records it, then commits cleanly
        FS.put(FS.key("t.example", "kb", "2099-01-01"), FS._today_utc()); FS.get(K)
    assert "late_commit" in g("show", "HEAD:data/hand-anomalies.jsonl")
    assert g("status", "--porcelain", "--", "data/hand-first-seen.jsonl", "data/hand-anomalies.jsonl").strip() == ""

def test_r6_3_show_failure_raises_not_empty_baseline(repo, monkeypatch):
    d, g = repo
    f = d / "data" / "hand-first-seen.jsonl"; f.write_text('{"a":1}\n'); g("commit", "-qam", "row")
    f.write_text('{"a":1}\n{"b":2}\n')
    real = LC._gitb
    monkeypatch.setattr(LC, "_gitb", lambda cwd, *a: subprocess.CompletedProcess(a, 128, b"", b"fatal: boom") if a[0] == "show" else real(cwd, *a))
    with pytest.raises(LC.LedgerCommitError, match="baseline"): LC.flush_and_commit()

def test_r6_3_replaced_file_direct_flush_refused(repo):
    d, g = repo
    f = d / "data" / "hand-first-seen.jsonl"; f.write_text('{"a":1}\n'); g("commit", "-qam", "row")
    f.write_text('{"z":9}\n')
    with pytest.raises(LC.LedgerCommitError, match="append-only"): LC.flush_and_commit()

def test_r6_3_new_file_not_in_head_is_empty_baseline(repo):
    d, g = repo
    g("rm", "-q", "data/hand-anomalies.jsonl"); g("commit", "-qm", "rm")
    (d / "data" / "hand-anomalies.jsonl").write_text('{"x":1}\n')
    assert LC.flush_and_commit() is True

def test_note_a_uncommitted_foreign_rows_message(repo):
    d, g = repo
    with open(d / "data" / "hand-first-seen.jsonl", "a") as fh: fh.write('{"key":["f.example","kb",""],"first_seen":"2026-10-31"}\n')
    with pytest.raises(LC.LedgerCommitError) as ei:
        with LC.ledger_pass(): FS.put(FS.key("t.example", "kb", "2099-01-01"), FS._today_utc())
    m = str(ei.value); assert "commit or remove them by hand" in m and "data/hand-first-seen.jsonl" in m

def test_note_b_trust_error_outside_checkout_says_operator_checkout(tmp_path, monkeypatch):
    monkeypatch.delenv("KM_HAND_FIRST_SEEN")
    monkeypatch.setattr(FS.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 128, "", "not a git repository"))
    with pytest.raises(FS.LedgerTrustError, match="operator checkout"): FS._commit_dates(FS.path())

def test_note_c_lock_wait_times_out(repo, monkeypatch):
    import fcntl
    d, g = repo; monkeypatch.setattr(LC, "LOCK_TIMEOUT", 0.5)
    fd = os.open(str(d / "data" / ".ledger.lock"), os.O_RDWR | os.O_CREAT); fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        with pytest.raises(LC.LedgerCommitError, match="lock"):
            with LC.ledger_pass(): pass
    finally: fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)

def test_r6_2_ledgers_job_concurrency_and_delegates_to_script():
    """Wiring only; the base-selection and scan behavior is tested in tests/test_ci_ledger_check.py."""
    import re
    text = open(os.path.join(REPO, ".github", "workflows", "site.yml")).read()
    j = re.search(r"(?ms)^  ledgers:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", text).group(1)
    assert re.search(r"(?m)^    concurrency:\n      group: ledgers-\$\{\{ github\.ref \}\}\n      cancel-in-progress: false$", j)
    assert "crawler/ci_ledger_check.py" in j and "AND merge base" not in j
