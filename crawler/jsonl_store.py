#!/usr/bin/env python3
"""Shared append-only JSONL helpers for the tracked ledgers (hand_anomalies.py, hand_first_seen.py).
- default location: the repo's tracked data/ dir (Satoshi 2026-10-31: both ledgers are tracked in git; they hold only
  domain, author label and dates). Append-only is enforced by tests/test_tracked_ledgers.py and check_append_only.py.
- env path override is validated: it must resolve (symlinks included) under that data/ dir or a tmp dir, nothing else.
- corrupt lines are skipped and counted, never raised."""
import json, os, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")

def _under(real, root):
    root = os.path.realpath(root).rstrip(os.sep) + os.sep
    return real.startswith(root)

def resolve(env, default_name):
    """Path for a store: $env if set and safe, else data/<default_name>. Raises ValueError for an unsafe $env.
    Production accepts only the tracked data/ dir. A tmp dir is accepted only with KM_TEST_LEDGERS=1 (tests/conftest.py),
    so a prod run can never silently use a throwaway ledger."""
    v = os.environ.get(env)
    if not v: return os.path.join(DATA, default_name)
    real = os.path.realpath(v)
    if _under(real, DATA): return v
    if any(_under(real, t) for t in (tempfile.gettempdir(), "/tmp")):
        if os.environ.get("KM_TEST_LEDGERS") == "1": return v
        raise ValueError(f"{env}={v!r} is under a tmp dir; refused outside tests (set KM_TEST_LEDGERS=1 only in tests)")
    raise ValueError(f"{env}={v!r} resolves to {real!r}, outside the tracked data/ dir; refused")

def read(p):
    """(events, corrupt_count). Missing file -> ([], 0)."""
    if not os.path.exists(p): return [], 0
    evs, bad = [], 0
    with open(p, errors="replace") as f:
        for l in f:
            if not l.strip(): continue
            try:
                e = json.loads(l)
                if isinstance(e, dict): evs.append(e)
                else: bad += 1
            except ValueError: bad += 1
    return evs, bad

def append(p, ev):
    """Append one whole line under an flock (no interleaved half-lines) and note it in the active ledger pass."""
    import fcntl
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    data = (json.dumps(ev, separators=(",", ":")) + "\n").encode()
    with open(p, "ab") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try: f.write(data); f.flush()
        finally: fcntl.flock(f, fcntl.LOCK_UN)
    try:
        import ledger_commit; ledger_commit.journal_append(p, data)
    except ImportError: pass
