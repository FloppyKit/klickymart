"""r7-1: behavioral tests of the CI ledger check (crawler/ci_ledger_check.py) in temp git repos."""
import os, shutil, subprocess, sys, pytest
CRAWLER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F = "data/hand-anomalies.jsonl"

@pytest.fixture
def repo(tmp_path):
    if not shutil.which("git"): pytest.skip("git unavailable")
    d = tmp_path / "r"; (d / "data").mkdir(parents=True)
    def g(*a): return subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, text=True).stdout.strip()
    g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t")
    (d / ".gitattributes").write_text(f"{F} merge=union\n")
    (d / F).write_text('{"r":"base"}\n'); (d / "data" / "hand-first-seen.jsonl").write_text("")
    g("add", "."); g("commit", "-qm", "base")
    return d, g

def app(d, g, line, msg):
    with open(d / F, "a") as f: f.write(line + "\n")
    g("commit", "-qam", msg); return g("rev-parse", "HEAD")

def run(d, *args):
    return subprocess.run([sys.executable, os.path.join(CRAWLER, "ci_ledger_check.py"), "--main-ref", "main", *args],
                          cwd=str(d), capture_output=True, text=True)

def test_union_merge_of_two_appending_branches_passes(repo):
    d, g = repo
    g("checkout", "-qb", "side"); app(d, g, '{"r":"S"}', "side")
    g("checkout", "-q", "main"); before = g("rev-parse", "HEAD"); app(d, g, '{"r":"M"}', "main")
    g("merge", "-q", "--no-edit", "side")
    assert sorted((d / F).read_text().splitlines()) == sorted(['{"r":"base"}', '{"r":"M"}', '{"r":"S"}'])
    app(d, g, '{"r":"later"}', "later push")                         # the old ancestor scan failed every later push here
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 0, r.stdout + r.stderr

def test_edited_row_on_main_fails_at_that_commit(repo):
    d, g = repo
    before = app(d, g, '{"r":"a"}', "a")
    (d / F).write_text((d / F).read_text().replace('"a"', '"EDITED"')); g("commit", "-qam", "edit")
    bad = g("rev-parse", "HEAD"); app(d, g, '{"r":"b"}', "b")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 1 and bad[:12] in r.stdout, r.stdout

def test_zero_before_falls_back_to_merge_base(repo):
    d, g = repo
    mb = g("rev-parse", "HEAD"); g("checkout", "-qb", "feat"); app(d, g, '{"r":"f"}', "f")
    r = run(d, "--event", "push", "--ref", "refs/heads/feat", "--before", "0" * 40)
    assert r.returncode == 0 and f"base {mb}" in r.stdout, r.stdout
    (d / F).write_text('{"r":"x"}\n'); g("commit", "-qam", "rewrite")
    assert run(d, "--event", "push", "--ref", "refs/heads/feat", "--before", "0" * 40).returncode == 1

def test_unreachable_before_fails_closed(repo):
    d, g = repo
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", "deadbeef" * 5)
    assert r.returncode == 2, r.stdout + r.stderr

def test_pull_request_uses_pr_base(repo):
    d, g = repo
    base = g("rev-parse", "HEAD"); g("checkout", "-qb", "pr"); app(d, g, '{"r":"p"}', "p")
    r = run(d, "--event", "pull_request", "--ref", "refs/pull/1/merge", "--pr-base", base)
    assert r.returncode == 0 and f"base {base}" in r.stdout
