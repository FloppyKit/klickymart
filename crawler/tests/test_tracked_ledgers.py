import os, shutil, subprocess, sys, pytest
CRAWLER = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); sys.path.insert(0, CRAWLER)
REPO = os.path.dirname(CRAWLER)
import hand_anomalies as HA, hand_first_seen as FS, jsonl_store
TRACKED = ["data/hand-first-seen.jsonl", "data/hand-anomalies.jsonl"]

def test_default_paths_are_tracked_data_dir(monkeypatch):
    monkeypatch.delenv("KM_HAND_ANOMALIES"); monkeypatch.delenv("KM_HAND_FIRST_SEEN")
    assert HA.path() == os.path.join(REPO, "data", "hand-anomalies.jsonl")
    assert FS.path() == os.path.join(REPO, "data", "hand-first-seen.jsonl")

def test_env_allows_only_data_dir_or_tmp(monkeypatch, tmp_path):
    monkeypatch.setenv("KM_HAND_ANOMALIES", os.path.join(REPO, "data", "x.jsonl")); HA.path()
    monkeypatch.setenv("KM_HAND_ANOMALIES", str(tmp_path / "x.jsonl")); HA.path()
    import tempfile
    in_tmp = os.path.realpath(REPO).startswith(os.path.realpath(tempfile.gettempdir()) + os.sep)
    bads = ["/etc/x.jsonl", "/var/x.jsonl"]
    if not in_tmp: bads += [os.path.join(CRAWLER, "out", "x.jsonl"), os.path.join(REPO, "x.jsonl")]   # a /tmp checkout is itself "tmp"
    for bad in bads:
        monkeypatch.setenv("KM_HAND_ANOMALIES", bad)
        with pytest.raises(ValueError): HA.path()

def test_conftest_redirects_to_tmp():
    import tempfile
    for v in ("KM_HAND_ANOMALIES", "KM_HAND_FIRST_SEEN"):
        assert os.path.realpath(os.environ[v]).startswith(os.path.realpath(tempfile.gettempdir()))

def _head(path):
    if not shutil.which("git"): pytest.skip("git unavailable")
    r = subprocess.run(["git", "-C", REPO, "show", f"HEAD:{path}"], capture_output=True)
    if r.returncode != 0: pytest.skip(f"{path} not at HEAD")
    return r.stdout

@pytest.mark.parametrize("path", TRACKED)
def test_tracked_ledger_is_append_only_vs_head(path):
    head = _head(path)
    cur = open(os.path.join(REPO, path), "rb").read()
    assert cur.startswith(head), f"{path}: working copy does not start with HEAD bytes (only appends allowed)"

def test_clear_appends_reason_row_never_rewrites(tmp_path):
    p = str(tmp_path / "ha.jsonl")
    eid = HA.record({"author": "kb", "domain": "a.example", "kind": "future_hand_at", "hand_at": "2099-01-01T00:00:00+00:00"}, path=p)
    before = open(p, "rb").read()
    HA.clear(eid, "matt", reason="typo", path=p)
    after = open(p, "rb").read(); assert after.startswith(before)
    import json; row = json.loads(after.decode().strip().splitlines()[-1])
    assert (row["event"], row["id"], row["cleared_by"], row["reason"]) == ("clear", eid, "matt", "typo") and row["date"]
    eid2 = HA.record({"author": "kb", "domain": "b.example", "kind": "future_hand_at", "hand_at": "x"}, path=p)
    HA.clear(eid2, "matt", note="alias still works", path=p)
    assert json.loads(open(p).read().strip().splitlines()[-1])["reason"] == "alias still works"

def test_clear_review_keeps_full_history():
    from btc_grade import clear_review
    r = {"btc_grade_needs_review": True}
    for i in range(3): r = clear_review(dict(r, btc_grade_needs_review=True), f"op{i}", f"r{i}", now=f"2026-11-0{i+1}T00:00:00Z")
    assert [x["cleared_by"] for x in r["btc_grade_review_log"]] == ["op0", "op1", "op2"]

def _git_repo(tmp_path):
    if not shutil.which("git"): pytest.skip("git unavailable")
    d = tmp_path / "repo"; d.mkdir()
    run = lambda *a: subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True)
    run("init", "-q"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
    (d / "data").mkdir(); f = d / "data" / "hand-anomalies.jsonl"; f.write_text('{"a":1}\n{"a":2}\n')
    run("add", "data/hand-anomalies.jsonl"); run("commit", "-qm", "base")
    return d, f

def _check(d, *extra):
    return subprocess.run([sys.executable, os.path.join(CRAWLER, "check_append_only.py"), "HEAD", *extra], cwd=str(d), capture_output=True, text=True)

def test_check_script_allows_append(tmp_path):
    d, f = _git_repo(tmp_path); f.write_text('{"a":1}\n{"a":2}\n{"a":3}\n')
    r = _check(d, "--paths", "data/hand-anomalies.jsonl"); assert r.returncode == 0, r.stdout + r.stderr

@pytest.mark.parametrize("new", ['{"a":1}\n', '{"a":1}\n{"a":9}\n', '{"a":2}\n{"a":1}\n', '{"a":1}\n{"a":2}', ''])
def test_check_script_fails_on_removed_or_edited(tmp_path, new):
    d, f = _git_repo(tmp_path); f.write_text(new)
    r = _check(d, "--paths", "data/hand-anomalies.jsonl"); assert r.returncode == 1, r.stdout + r.stderr


def test_p2_c_bad_ref_fails_closed(tmp_path):
    d, f = _git_repo(tmp_path)
    r = _check_ref(d, "nonexistent-ref"); assert r.returncode == 2, r.stdout + r.stderr
    r = subprocess.run([sys.executable, os.path.join(CRAWLER, "check_append_only.py"), "nonexistent-ref"], cwd=str(d), capture_output=True, text=True)
    assert r.returncode != 0

def test_p2_c_new_path_at_valid_base_ok(tmp_path):
    d, f = _git_repo(tmp_path); (d / "data" / "new.jsonl").write_text('{"b":1}\n')
    r = _check(d, "--paths", "data/new.jsonl"); assert r.returncode == 0, r.stdout

def _base(d, content):
    f = d / "data" / "hand-anomalies.jsonl"; f.write_bytes(content)
    subprocess.run(["git", "-C", str(d), "commit", "-qam", "b2"], check=True, capture_output=True)
    return f

def test_p2_d_unterminated_last_line_extended_fails(tmp_path):
    d, _ = _git_repo(tmp_path); f = _base(d, b'{"a":1}\n{"first_seen":"2026-10-31"}')
    f.write_bytes(b'{"a":1}\n{"first_seen":"2026-10-31"}x\n')
    assert _check(d, "--paths", "data/hand-anomalies.jsonl").returncode == 1

def test_p2_d_unterminated_base_fails_even_unchanged(tmp_path):
    d, _ = _git_repo(tmp_path); _base(d, b'{"a":1}')
    assert _check(d, "--paths", "data/hand-anomalies.jsonl").returncode == 1

@pytest.mark.parametrize("new", [b'{"a":1}\r\n{"a":2}\n', b'{"a":1}\n{"a":2}\n{"a":3}\r\n'])
def test_p2_d_carriage_return_fails(tmp_path, new):
    d, f = _git_repo(tmp_path); f.write_bytes(new)
    assert _check(d, "--paths", "data/hand-anomalies.jsonl").returncode == 1

def _check_ref(d, ref):
    return subprocess.run([sys.executable, os.path.join(CRAWLER, "check_append_only.py"), ref, "--paths", "data/hand-anomalies.jsonl"], cwd=str(d), capture_output=True, text=True)

def test_ci_workflow_runs_append_only_check():
    wf = open(os.path.join(REPO, ".github", "workflows", "site.yml")).read()
    assert "check_append_only.py" in wf and "fetch-depth: 0" in wf
