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

def test_r8_1_reordering_merge_fails(repo):
    d, g = repo
    before = g("rev-parse", "HEAD")
    env = dict(os.environ, GIT_COMMITTER_DATE="2026-10-20T12:00:00", GIT_AUTHOR_DATE="2026-10-20T12:00:00")  # throwaway repo
    with open(d / F, "a") as f: f.write('{"r":"old"}\n')
    subprocess.run(["git", "-C", str(d), "commit", "-qam", "old row"], check=True, env=env)
    g("checkout", "-qb", "side", before); app(d, g, '{"r":"S"}', "side"); g("checkout", "-q", "main")
    subprocess.run(["git", "-C", str(d), "merge", "-q", "--no-commit", "side"], capture_output=True)
    (d / F).write_text('{"r":"base"}\n{"r":"S"}\n{"r":"old"}\n')   # moves "old" below S: blame would re-date it
    g("add", F); g("commit", "-qm", "reordering merge"); bad = g("rev-parse", "HEAD")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 1 and bad[:12] in r.stdout, r.stdout

def test_r8_1_reorder_in_non_merge_commit_fails(repo):
    d, g = repo
    before = app(d, g, '{"r":"a"}', "a")
    (d / F).write_text('{"r":"a"}\n{"r":"base"}\n'); g("commit", "-qam", "reorder"); bad = g("rev-parse", "HEAD")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 1 and bad[:12] in r.stdout, r.stdout

def test_r8_2_non_ancestor_before_fails_closed(repo):
    d, g = repo
    old = app(d, g, '{"r":"a"}', "a"); g("branch", "keep-old")         # old tip stays reachable via another branch
    g("reset", "-q", "--hard", "HEAD~1"); app(d, g, '{"r":"b"}', "rewritten main")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", old)
    assert r.returncode == 2 and "append-only scan" not in r.stdout, r.stdout
    r = run(d, "--event", "push", "--ref", "refs/heads/feat", "--before", old)
    assert r.returncode == 2, r.stdout
    r = run(d, "--event", "pull_request", "--ref", "refs/pull/1/merge", "--pr-base", old)
    assert r.returncode == 2, r.stdout

def test_r9_1_merge_reordering_second_parent_rows_fails(repo):
    d, g = repo
    before = g("rev-parse", "HEAD")
    g("checkout", "-qb", "side")
    env = dict(os.environ, GIT_COMMITTER_DATE="2026-10-20T12:00:00", GIT_AUTHOR_DATE="2026-10-20T12:00:00")  # throwaway repo
    with open(d / F, "a") as f: f.write('{"r":"s1"}\n')
    subprocess.run(["git", "-C", str(d), "commit", "-qam", "s1"], check=True, env=env)
    app(d, g, '{"r":"s2"}', "s2"); g("checkout", "-q", "main"); app(d, g, '{"r":"m"}', "m")
    subprocess.run(["git", "-C", str(d), "merge", "-q", "--no-commit", "side"], capture_output=True)
    (d / F).write_text('{"r":"base"}\n{"r":"m"}\n{"r":"s2"}\n{"r":"s1"}\n')   # swaps s1/s2: blame would re-date s1
    g("add", F); g("commit", "-qm", "swap merge"); bad = g("rev-parse", "HEAD")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 1 and bad[:12] in r.stdout, r.stdout

def test_r9_1_criss_cross_union_merges_pass(repo):
    # Deflake (2026-11-01): with a criss-cross, git builds a virtual merge base from two bases; when s2 and m1 share a
    # commit second and the side<-main merge lands a second later, git's tie-break flips the virtual base and the union
    # output reorders first-parent rows (checker correctly FAILs "first parent not an exact prefix"). Pin strictly
    # increasing dates, only inside this throwaway repo, so the test exercises one fixed, known-good history.
    d, _g = repo
    t0 = int(subprocess.run(["git", "-C", str(d), "log", "-1", "--format=%ct"], capture_output=True, text=True).stdout) + 10
    tick = iter(range(t0, t0 + 100))   # after the fixture's base commit
    def g(*a):
        if a and a[0] in ("commit", "merge"):
            t = f"@{next(tick)} +0000"; e = dict(os.environ, GIT_COMMITTER_DATE=t, GIT_AUTHOR_DATE=t)
            return subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, text=True, env=e).stdout.strip()
        return _g(*a)
    before = g("rev-parse", "HEAD")
    g("checkout", "-qb", "side"); app(d, g, '{"r":"s1"}', "s1"); app(d, g, '{"r":"s2"}', "s2")
    g("checkout", "-q", "main"); app(d, g, '{"r":"m1"}', "m1")
    g("merge", "-q", "--no-edit", "side")                       # main <- side
    g("checkout", "-q", "side"); g("merge", "-q", "--no-edit", "main~1")   # side <- old main (criss-cross)
    app(d, g, '{"r":"s3"}', "s3")
    g("checkout", "-q", "main"); app(d, g, '{"r":"m2"}', "m2")
    g("merge", "-q", "--no-edit", "side")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 0, r.stdout + r.stderr


def test_r9_1_criss_cross_same_second_tie_reorders_and_fails_closed(repo):
    """Documents the flake's root cause: git's own union output reorders first-parent rows for this date pattern, and
    the checker refuses it (fail closed). A real criss-cross like this needs a hand-resolved merge, first-parent rows first."""
    d, _g = repo
    t0 = int(_g("log", "-1", "--format=%ct")) + 10
    deltas = iter([0, 0, 0, 0, 1, 1, 1, 1])   # s1, s2, m1, merge M<-S same second; S<-M~1 merge one second later
    def g(*a):
        if a and a[0] in ("commit", "merge"):
            t = f"@{t0 + next(deltas)} +0000"; e = dict(os.environ, GIT_COMMITTER_DATE=t, GIT_AUTHOR_DATE=t)
            return subprocess.run(["git", "-C", str(d), *a], check=True, capture_output=True, text=True, env=e).stdout.strip()
        return _g(*a)
    before = g("rev-parse", "HEAD")
    g("checkout", "-qb", "side"); app(d, g, '{"r":"s1"}', "s1"); app(d, g, '{"r":"s2"}', "s2")
    g("checkout", "-q", "main"); app(d, g, '{"r":"m1"}', "m1")
    g("merge", "-q", "--no-edit", "side")
    g("checkout", "-q", "side"); g("merge", "-q", "--no-edit", "main~1")
    app(d, g, '{"r":"s3"}', "s3")
    g("checkout", "-q", "main"); app(d, g, '{"r":"m2"}', "m2")
    g("merge", "-q", "--no-edit", "side")
    first = _g("show", f"HEAD^1:{F}").splitlines(); merged = (d / F).read_text().splitlines()
    if merged[:len(first)] == first: pytest.skip("this git version keeps first-parent order here; nothing to document")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 1 and "first parent not an exact prefix" in r.stdout, r.stdout + r.stderr


def test_duplicate_rows_are_set_semantics_warning_not_failure(repo):
    """Satoshi 2026-11-01: byte-identical rows count once. Side repeats X; the hand-resolved merge keeps X once."""
    d, g = repo
    before = g("rev-parse", "HEAD")
    g("checkout", "-qb", "side"); app(d, g, '{"r":"X"}', "x"); app(d, g, '{"r":"S"}', "s"); app(d, g, '{"r":"X"}', "x again")
    g("checkout", "-q", "main"); app(d, g, '{"r":"M"}', "m")
    subprocess.run(["git", "-C", str(d), "merge", "-q", "--no-commit", "side"], capture_output=True)
    (d / F).write_text('{"r":"base"}\n{"r":"M"}\n{"r":"X"}\n{"r":"S"}\n'); g("add", F); g("commit", "-qm", "merge, X once")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "WARNING" in r.stdout and "duplicate" in r.stdout, r.stdout
    assert (d / F).read_text().count('{"r":"X"}') == 1   # checker never rewrites the ledger

def test_duplicate_append_on_one_branch_warns_and_passes(repo):
    d, g = repo
    before = g("rev-parse", "HEAD"); app(d, g, '{"r":"base"}', "dup of base row")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 0 and "WARNING" in r.stdout and "1 byte-identical duplicate" in r.stdout, r.stdout
    assert (d / F).read_text() == '{"r":"base"}\n{"r":"base"}\n'

def test_dropping_a_distinct_row_still_fails(repo):
    d, g = repo
    before = g("rev-parse", "HEAD")
    g("checkout", "-qb", "side"); app(d, g, '{"r":"S1"}', "s1"); app(d, g, '{"r":"S2"}', "s2")
    g("checkout", "-q", "main"); app(d, g, '{"r":"M"}', "m")
    subprocess.run(["git", "-C", str(d), "merge", "-q", "--no-commit", "side"], capture_output=True)
    (d / F).write_text('{"r":"base"}\n{"r":"M"}\n{"r":"S1"}\n'); g("add", F); g("commit", "-qm", "drops S2")
    r = run(d, "--event", "push", "--ref", "refs/heads/main", "--before", before)
    assert r.returncode == 1 and "parent 2" in r.stdout, r.stdout
