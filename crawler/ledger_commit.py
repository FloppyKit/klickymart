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
import datetime, os, subprocess, sys

def _warn(msg): print(f"ledger_commit: {msg}", file=sys.stderr)

def ledger_paths():
    import hand_first_seen, hand_anomalies
    return [hand_first_seen.path(), hand_anomalies.path()]

def _git(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True)

def flush_and_commit(paths=None):
    """Commit pending changes to the ledger files only. Returns True when a commit was made."""
    try: paths = [os.path.abspath(p) for p in (paths or ledger_paths())]
    except ValueError as e: _warn(f"ledger path refused ({e}); nothing committed"); return False
    try:
        top = _git(os.path.dirname(paths[0]), "rev-parse", "--show-toplevel")
    except OSError as e:
        _warn(f"git unavailable ({e}); ledger rows left uncommitted"); return False
    if top.returncode != 0:
        _warn(f"not inside a git checkout ({os.path.dirname(paths[0])}); ledger rows left uncommitted"); return False
    top = top.stdout.strip()
    rel = [os.path.relpath(os.path.realpath(p), os.path.realpath(top)) for p in paths if os.path.exists(p)]
    if not rel: return False
    st = _git(top, "status", "--porcelain", "--", *rel)
    if st.returncode != 0 or not st.stdout.strip(): return False   # nothing new this pass
    if os.environ.get("KM_LEDGER_AUTOCOMMIT") != "1":
        _warn("NOTE: new ledger rows are UNCOMMITTED (KM_LEDGER_AUTOCOMMIT is off). first-seen rows will be re-dated to their "
              "commit date once committed (strict floor). Set KM_LEDGER_AUTOCOMMIT=1 to commit them in the same pass.")
        return False
    untracked = [l[3:] for l in st.stdout.splitlines() if l.startswith("??")]
    if untracked and _git(top, "add", "--", *untracked).returncode != 0:
        _warn("git add of new ledger file failed; rows left uncommitted"); return False
    msg = f"ledger: first-seen/anomalies {datetime.datetime.now(datetime.timezone.utc).date().isoformat()}"
    r = _git(top, "commit", "-q", "-m", msg, "--only", "--", *rel)
    if r.returncode != 0:
        _warn(f"commit failed ({(r.stderr or r.stdout).strip()[:200]}); rows left uncommitted"); return False
    return True
