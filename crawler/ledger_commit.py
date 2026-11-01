#!/usr/bin/env python3
"""Commit new ledger rows in the same pass that wrote them (Satoshi 2026-10-31).

hand_first_seen.get() uses the line's commit date as a STRICT floor, so a row committed a day after it was written would
be re-dated. Each build/grade pass therefore ends with ONE flush_and_commit(): it commits only the ledger paths
(`git commit --only -- <paths>`), never other staged or dirty files. Gated on KM_LEDGER_AUTOCOMMIT=1 (default off;
tests/conftest.py forces it off). Never crashes the caller: outside a git checkout or on a failed commit it warns and
returns False. Never pushes, never sets GIT_COMMITTER_DATE.

NOTE: committer dates are operator-settable, so the commit-date floor only stops casual backdating. Signing rows with the
operator key under the v9.2 key lifecycle closes the rest; a push-time floor (server-side receive date) is a possible
later add."""
import contextlib, datetime, fcntl, os, subprocess, sys, threading

GIT_TIMEOUT = 30   # r5-7: seconds per git subprocess; a timeout fails the pass

class LedgerCommitError(RuntimeError):
    """The pass's ledger commit failed or was tampered with: the pass must exit non-zero."""

def _warn(msg): print(f"ledger_commit: {msg}", file=sys.stderr)

def ledger_paths():
    import hand_first_seen, hand_anomalies
    return [hand_first_seen.path(), hand_anomalies.path()]

def _git(cwd, *a):
    try: return subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True, timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired: raise LedgerCommitError(f"git {a[0]} timed out after {GIT_TIMEOUT}s")

def _gitb(cwd, *a):
    try: return subprocess.run(["git", "-C", cwd, *a], capture_output=True, timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired: raise LedgerCommitError(f"git {a[0]} timed out after {GIT_TIMEOUT}s")

# ---- one pass: exclusive lock across append + commit (r5-4) ----
_pass = threading.local()

def pass_active():
    return getattr(_pass, "journal", None) is not None

def journal_append(p, data):
    """Called by jsonl_store.append: remember the bytes this pass wrote to each ledger."""
    j = getattr(_pass, "journal", None)
    if j is not None: j.setdefault(os.path.realpath(p), b""); j[os.path.realpath(p)] += data

@contextlib.contextmanager
def ledger_pass(paths=None):
    """Hold data/.ledger.lock (fcntl, exclusive) for the whole pass: appends, then ONE flush_and_commit at the end.
    A commit failure raises LedgerCommitError out of the pass (non-zero exit). Not re-entrant across threads."""
    paths = paths or ledger_paths()
    lock = os.path.join(os.path.dirname(os.path.abspath(paths[0])), ".ledger.lock")
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        _pass.journal = {}
        try:
            yield
            flush_and_commit(paths, journal=_pass.journal)
        finally:
            _pass.journal = None
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN); os.close(fd)

def begin_pass(paths=None):
    """Script-style ledger_pass (build_v4 is module-level code): returns the context; call end_pass(ctx) at the end."""
    ctx = ledger_pass(paths); ctx.__enter__(); return ctx

def end_pass(ctx):
    ctx.__exit__(None, None, None)

def flush_and_commit(paths=None, journal=None):
    """Commit this pass's ledger appends only. Returns True when a commit was made. Raises LedgerCommitError on any
    failure once autocommit is on (r5-4/5/6/7); only 'autocommit off' and 'not a git checkout' just warn."""
    try: paths = [os.path.abspath(p) for p in (paths or ledger_paths())]
    except ValueError as e: raise LedgerCommitError(f"ledger path refused ({e})")
    try: top = subprocess.run(["git", "-C", os.path.dirname(paths[0]), "rev-parse", "--show-toplevel"],
                              capture_output=True, text=True, timeout=GIT_TIMEOUT)
    except OSError as e:
        _warn(f"git unavailable ({e}); ledger rows left uncommitted"); return False
    except subprocess.TimeoutExpired: raise LedgerCommitError(f"git rev-parse timed out after {GIT_TIMEOUT}s")
    if top.returncode != 0:
        _warn(f"not inside a git checkout ({os.path.dirname(paths[0])}); ledger rows left uncommitted"); return False
    top = top.stdout.strip()
    paths = [p for p in paths if os.path.exists(p)]
    rel = [os.path.relpath(os.path.realpath(p), os.path.realpath(top)) for p in paths]
    if not rel: return False
    st = _git(top, "status", "--porcelain", "--", *rel)
    if st.returncode != 0: raise LedgerCommitError(f"git status failed: {(st.stderr or st.stdout).strip()[:200]}")
    if not st.stdout.strip(): return False   # nothing new this pass
    if os.environ.get("KM_LEDGER_AUTOCOMMIT") != "1":
        _warn("NOTE: new ledger rows are UNCOMMITTED (KM_LEDGER_AUTOCOMMIT is off). Uncommitted rows don't count, and "
              "first-seen rows are clamped to their commit date once committed. Set KM_LEDGER_AUTOCOMMIT=1 to commit them "
              "in the same pass.")
        return False
    from check_append_only import check_bytes
    head, expect = {}, {}
    for p, r in zip(paths, rel):
        h = _gitb(top, "show", f"HEAD:{r}")
        head[r] = h.stdout if h.returncode == 0 else b""
        cur = open(p, "rb").read()
        why = check_bytes(head[r], cur)                              # r5-5: whole-line appends only vs HEAD
        if why: raise LedgerCommitError(f"refusing to commit {r}: not append-only vs HEAD ({why})")
        if journal is not None:                                      # r5-4: only THIS pass's rows
            mine = journal.get(os.path.realpath(p), b"")
            if cur != head[r] + mine:
                raise LedgerCommitError(f"refusing to commit {r}: it holds uncommitted rows not written by this pass "
                                        f"({len(cur) - len(head[r]) - len(mine)} extra bytes); commit or remove them by hand")
        expect[r] = cur
    untracked = [l[3:] for l in st.stdout.splitlines() if l.startswith("??")]
    if untracked:
        a = _git(top, "add", "--", *untracked)
        if a.returncode != 0: raise LedgerCommitError(f"git add of new ledger file failed: {a.stderr.strip()[:200]}")
    msg = f"ledger: first-seen/anomalies {datetime.datetime.now(datetime.timezone.utc).date().isoformat()}"
    c = _git(top, "commit", "-q", "-m", msg, "--only", "--", *rel)      # hooks run (never --no-verify)
    if c.returncode != 0: raise LedgerCommitError(f"commit failed (incl. pre-commit hook): {(c.stderr or c.stdout).strip()[:300]}")
    # r5-6: the commit must hold exactly HEAD~1 + this pass's rows; a hook that changed anything is reported, not undone
    bad = []
    for r in rel:
        got = _gitb(top, "show", f"HEAD:{r}")
        if got.returncode != 0 or got.stdout != expect[r]: bad.append(r)
    others = [x for x in _git(top, "show", "--name-only", "--format=", "HEAD").stdout.split() if x not in rel]
    if bad or others:
        raise LedgerCommitError(f"post-commit check FAILED: a hook changed the ledger commit (ledger content differs: {bad}; "
                                f"extra files: {others}). The commit was NOT undone; inspect HEAD by hand.")
    return True
