"""r5-4..r5-7: the ledger pass (lock, append-only pre-check, hooks, post-verify, timeouts) in a temp git repo."""
import json, os, shutil, subprocess, sys, textwrap, pytest
CRAWLER = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, CRAWLER)
import ledger_commit as LC, hand_first_seen as FS

@pytest.fixture
def repo(tmp_path, monkeypatch):
    if not shutil.which("git"): pytest.skip("git unavailable")
    d = tmp_path / "repo"; (d / "data").mkdir(parents=True)
    g = lambda *a: subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, text=True).stdout
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    for n in ("hand-first-seen.jsonl", "hand-anomalies.jsonl"): (d / "data" / n).write_text("")
    g("add", "."); g("commit", "-qm", "base")
    env = {"KM_HAND_FIRST_SEEN": str(d / "data" / "hand-first-seen.jsonl"), "KM_HAND_ANOMALIES": str(d / "data" / "hand-anomalies.jsonl"),
           "KM_LEDGER_AUTOCOMMIT": "1", "KM_TEST_LEDGERS": "1"}
    for k, v in env.items(): monkeypatch.setenv(k, v)
    return d, g, env

def put_rows(domains):
    with LC.ledger_pass():
        for dmn in domains: FS.put(FS.key(dmn, "kb", "2099-01-01"), FS._today_utc())

WORKER = textwrap.dedent("""
    import sys, time; sys.path.insert(0, %r)
    import ledger_commit as LC, hand_first_seen as FS
    with LC.ledger_pass():
        for i in range(5):
            FS.put(FS.key(f"{sys.argv[1]}{i}.example", "kb", "2099-01-01"), FS._today_utc()); time.sleep(0.05)
""") % CRAWLER

def test_r5_4_two_concurrent_passes_each_commit_whole_rows(repo):
    d, g, env = repo
    ps = [subprocess.Popen([sys.executable, "-c", WORKER, tag], env=dict(os.environ, **env), stderr=subprocess.PIPE, text=True) for tag in ("a", "b")]
    for p in ps: assert p.wait(timeout=120) == 0, p.stderr.read()
    assert g("rev-list", "--count", "HEAD").strip() == "3"                       # base + one commit per pass
    for rev in ("HEAD", "HEAD~1"):
        added = [l for l in g("show", "--format=", "-U0", rev, "--", "data/hand-first-seen.jsonl").splitlines() if l.startswith("+{")]
        tags = {json.loads(l[1:])["key"][0][0] for l in added}
        assert len(added) == 5 and len(tags) == 1                               # each commit holds only its own pass's rows
    assert open(d / "data" / "hand-first-seen.jsonl", "rb").read().endswith(b"\n")
    r = subprocess.run([sys.executable, os.path.join(CRAWLER, "check_append_only.py"), "HEAD~2"], cwd=str(d), capture_output=True, text=True)
    assert r.returncode == 0, r.stdout

def test_r5_4_held_index_lock_fails_the_pass(repo):
    d, g, env = repo
    (d / ".git" / "index.lock").write_text("")
    try:
        with pytest.raises(LC.LedgerCommitError, match="commit failed"): put_rows(["x.example"])
    finally: (d / ".git" / "index.lock").unlink()

def test_r5_4_callers_exit_nonzero_on_commit_failure(repo, tmp_path):
    d, g, env = repo
    (d / ".git" / "index.lock").write_text("")
    src, dst = tmp_path / "in.jsonl", tmp_path / "out.jsonl"
    src.write_text(json.dumps({"d": "s.example", "status": "crawled", "btc": 0, "btc_src": "hand", "btc_grade_hand_by": "kb",
                               "btc_grade_hand_at": "2099-01-01", "btc_grade_hand_evidence": "https://s.example/pay", "btc_any": True}) + "\n")
    r = subprocess.run([sys.executable, os.path.join(CRAWLER, "btc_grade.py"), str(src), str(dst), str(tmp_path / "none.jsonl")],
                       env=dict(os.environ, **env), capture_output=True, text=True, timeout=120)
    (d / ".git" / "index.lock").unlink()
    assert r.returncode != 0 and "LedgerCommitError" in r.stderr

def test_r5_5_edit_of_committed_row_refused(repo):
    d, g, env = repo
    put_rows(["a.example"])
    f = d / "data" / "hand-first-seen.jsonl"; f.write_text(f.read_text().replace(FS._today_utc(), "2026-01-09"))
    n = g("rev-list", "--count", "HEAD")
    with pytest.raises(LC.LedgerCommitError, match="append-only"): put_rows(["b.example"])
    assert g("rev-list", "--count", "HEAD") == n

def _hook(d, body):
    h = d / ".git" / "hooks" / "pre-commit"; h.write_text("#!/bin/sh\n" + body + "\n"); h.chmod(0o755)

def test_r5_6_failing_precommit_hook_fails_pass(repo):
    d, g, env = repo; _hook(d, "exit 1")
    with pytest.raises(LC.LedgerCommitError, match="commit failed"): put_rows(["a.example"])

def test_r5_6_hook_that_adds_rows_is_reported_not_undone(repo):
    d, g, env = repo
    _hook(d, """echo '{"key":["evil.example","kb",""],"first_seen":"2001-01-01"}' >> data/hand-first-seen.jsonl; git add data/hand-first-seen.jsonl""")
    with pytest.raises(LC.LedgerCommitError, match="hook"): put_rows(["a.example"])
    assert "evil.example" in g("show", "HEAD:data/hand-first-seen.jsonl")        # not silently undone

def test_r5_7_git_timeout_fails_pass(repo, monkeypatch):
    d, g, env = repo; monkeypatch.setattr(LC, "GIT_TIMEOUT", 1); _hook(d, "sleep 5")
    with pytest.raises(LC.LedgerCommitError, match="timed out"): put_rows(["a.example"])

def test_r5_7_status_failure_is_error(repo, monkeypatch):
    d, g, env = repo
    real = LC._git
    monkeypatch.setattr(LC, "_git", lambda cwd, *a: subprocess.CompletedProcess(a, 128, "", "boom") if a[0] == "status" else real(cwd, *a))
    with pytest.raises(LC.LedgerCommitError, match="status"): put_rows(["a.example"])
