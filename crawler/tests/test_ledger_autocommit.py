import os, shutil, subprocess, sys, pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import hand_first_seen as FS, hand_anomalies as HA, ledger_commit as LC
K = ("s.example", "kb", "2099-01-01")

@pytest.fixture
def repo(tmp_path, monkeypatch):
    if not shutil.which("git"): pytest.skip("git unavailable")
    d = tmp_path / "repo"; (d / "data").mkdir(parents=True)
    g = lambda *a: subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, text=True).stdout
    g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    for n in ("hand-first-seen.jsonl", "hand-anomalies.jsonl", "other.txt", "staged.txt"): (d / "data" / n).write_text("")
    g("add", "."); g("commit", "-qm", "base")
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", str(d / "data" / "hand-first-seen.jsonl"))
    monkeypatch.setenv("KM_HAND_ANOMALIES", str(d / "data" / "hand-anomalies.jsonl"))
    return d, g

def test_conftest_forces_autocommit_off():
    assert os.environ.get("KM_LEDGER_AUTOCOMMIT") == "0"

def test_autocommit_on_commits_only_ledger_paths(repo, monkeypatch):
    d, g = repo; monkeypatch.setenv("KM_LEDGER_AUTOCOMMIT", "1")
    FS.put(FS.key(*K), FS._today_utc())
    HA.record({"author": "kb", "domain": "s.example", "kind": "future_hand_at", "hand_at": "2099-01-01T00:00:00+00:00"})
    (d / "data" / "other.txt").write_text("dirty\n"); (d / "data" / "staged.txt").write_text("staged\n"); g("add", "data/staged.txt")
    assert LC.flush_and_commit() is True
    files = g("show", "--name-only", "--format=%s", "HEAD").split()
    assert files[0] == "ledger:" and sorted(files[-2:]) == ["data/hand-anomalies.jsonl", "data/hand-first-seen.jsonl"]
    assert "data/other.txt" not in files and "data/staged.txt" not in files
    st = g("status", "--porcelain")
    assert "M  data/staged.txt" in st and " M data/other.txt" in st and "hand-" not in st
    assert LC.flush_and_commit() is False                              # nothing new: no second commit this pass
    assert g("rev-list", "--count", "HEAD").strip() == "2"
    assert FS.get(FS.key(*K)) == FS._today_utc()                       # committed row passes the strict floor

def test_autocommit_off_no_commit_and_warns(repo, capsys):
    d, g = repo
    FS.put(FS.key(*K), FS._today_utc())
    assert LC.flush_and_commit() is False
    assert g("rev-list", "--count", "HEAD").strip() == "1"
    assert "uncommitted" in capsys.readouterr().err.lower()

def test_not_a_git_repo_warns_and_continues(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("KM_LEDGER_AUTOCOMMIT", "1")
    monkeypatch.setenv("KM_HAND_FIRST_SEEN", str(tmp_path / "fs.jsonl")); monkeypatch.setenv("KM_HAND_ANOMALIES", str(tmp_path / "ha.jsonl"))
    FS.put(FS.key(*K), FS._today_utc())
    assert LC.flush_and_commit() is False
    assert "not inside a git checkout" in capsys.readouterr().err
