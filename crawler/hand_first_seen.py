#!/usr/bin/env python3
"""Operator-side store of when this code first saw a hand override (n-2), so a rebuild that drops the record's
btc_grade_hand_first_seen cannot reset it and extend protection.

Append-only JSONL keyed by (domain, hand_by, hand_at normalized to UTC ISO seconds; "" when undated). A later write
never moves the value forward: get() is the MIN over all events. The record field is only a cache; btc_grade reads
this store first. Default path data/hand-first-seen.jsonl (TRACKED in git, append-only: enforced by
tests/test_tracked_ledgers.py and check_append_only.py); KM_HAND_FIRST_SEEN overrides (validated: data/ or a tmp dir).
Corrupt lines are skipped and counted.

p2-e (forged older rows): a row is valid only if first_seen is not earlier than its hand_at (when hand_at is parseable and
not in the future; future-dated rows exist precisely because first_seen < hand_at), checked at write AND read, and, for
a tracked file in a git checkout, not earlier than the commit date that introduced the line (git blame). Uncommitted
lines don't count (r5-2) except for the same-pass writer (allow_uncommitted=True). Committed rows are CLAMPED to their
commit date (r5-3: effective = max(written, commit date)) and a late commit is recorded as a late_commit anomaly.
get() is the min over valid rows only. Trust boundary: crawler/LEDGER-TRUST.md, 'Accepted residual: operator trust line'. This narrows forgery to "no earlier than
the commit"; operator-key signing of rows (v9.2 key lifecycle, gated on Matt's go) closes it fully later."""
import datetime, json, os, shutil, subprocess, sys, threading
import jsonl_store

_lock = threading.Lock()

def path():
    return jsonl_store.resolve("KM_HAND_FIRST_SEEN", "hand-first-seen.jsonl")

def norm_at(x):
    """hand_at as UTC ISO seconds ('2099-01-01T00:00:00+00:00'), or '' when missing/unreadable."""
    if x is None or x == "": return ""
    if isinstance(x, datetime.datetime): dt = x
    elif isinstance(x, datetime.date): dt = datetime.datetime(x.year, x.month, x.day)
    else:
        try: dt = datetime.datetime.fromisoformat(str(x).strip().replace("Z", "+00:00"))
        except (TypeError, ValueError): return ""
    dt = dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)
    return dt.astimezone(datetime.timezone.utc).replace(microsecond=0).isoformat()

def key(domain, hand_by, hand_at):
    return (domain or "", hand_by or "", norm_at(hand_at))

def _k(k): return list(key(*k))   # always normalized (idempotent on an already-normalized key)

_warned = set()
def _warn(msg):
    if msg not in _warned:
        _warned.add(msg); print(f"hand_first_seen: {msg}", file=sys.stderr)

def _today_utc():
    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()

def _hand_floor_ok(k, first_seen):
    """first_seen must not precede a parseable, non-future hand_at (p2-e)."""
    at = _k(k)[2]
    if not at: return True
    at_d = at[:10]   # already normalized to UTC ISO
    if at_d > _today_utc(): return True
    return first_seen >= at_d

class LedgerTrustError(RuntimeError):
    """The tracked ledger's commit-date floor can't be established (git missing / blame failed): fail closed."""

def _is_tracked_data(p):
    real = os.path.realpath(p)
    return real.startswith(os.path.realpath(jsonl_store.DATA).rstrip(os.sep) + os.sep)

def _commit_dates(p):
    """{line_no: committer UTC date or None (uncommitted)} for a git-tracked file; None when the file isn't in git.
    r5-2: for the tracked data/ ledger, a missing git or a failed blame raises LedgerTrustError (fail closed). Other
    (tmp/test) paths only warn and skip the check.
    Accepted operator-trust line: committer dates are operator-settable (GIT_COMMITTER_DATE), so this floor stops casual
    backdating only; see crawler/LEDGER-TRUST.md 'Accepted residual: operator trust line'."""
    strict = _is_tracked_data(p)
    def fail(msg):
        if strict: raise LedgerTrustError(f"{p}: {msg}; refusing to trust first-seen rows")
        _warn(f"{msg}: commit-date check on first_seen rows skipped"); return None
    if not shutil.which("git"): return fail("git unavailable")
    d, f = os.path.split(os.path.abspath(p))
    try:
        top = subprocess.run(["git", "-C", d, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=30)
        if top.returncode != 0:
            return fail("not inside a git checkout (run this inside the operator checkout of the repo, where data/ is "
                        "tracked in git)") if strict else None
        if subprocess.run(["git", "-C", d, "ls-files", "--error-unmatch", f], capture_output=True, timeout=30).returncode != 0:
            return fail("ledger file is not tracked in git") if strict else None
        r = subprocess.run(["git", "-C", d, "blame", "--line-porcelain", "--", f], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return fail(f"git failed ({type(e).__name__})")
    if r.returncode != 0: return fail("git blame failed")
    out, cur = {}, None
    for l in r.stdout.splitlines():
        parts = l.split(" ")
        if len(parts) >= 3 and len(parts[0]) == 40 and parts[1].isdigit():
            cur = (parts[0], int(parts[2]))
            out[cur[1]] = None if cur[0] == "0" * 40 else out.get(cur[1])
        elif l.startswith("committer-time ") and cur and cur[0] != "0" * 40:
            out[cur[1]] = datetime.datetime.fromtimestamp(int(l.split(" ", 1)[1]), datetime.timezone.utc).date().isoformat()
    return out

def _rows(p):
    if not os.path.exists(p): return []
    rows = []
    with open(p, errors="replace") as f:
        for n, l in enumerate(f, 1):
            if not l.strip(): continue
            try: e = json.loads(l)
            except ValueError: continue
            if isinstance(e, dict): rows.append((n, e))
    return rows

def _late_commit(want, written, committed, sink):
    """r5-3: a row committed on a later UTC day than its written first_seen is clamped AND flagged (late_commit) in the
    hand-anomaly ledger, keyed by author; idempotent (one entry per key), closed only by a human via clear(). Date
    granularity: first_seen is a date, so 'later than HAND_AT_SKEW' means a later UTC day; no grace window."""
    try:
        (sink or __import__("hand_anomalies").record)({"author": want[1], "domain": want[0], "kind": "late_commit",
                 "hand_at": f"{want[2]}|written={written}", "clamped_to": committed,
                 "seen_at": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    except ValueError as e:
        _warn(f"late_commit anomaly not recorded ({e})")

def _in_ledger_pass():
    try:
        import ledger_commit; return ledger_commit.pass_active()
    except ImportError: return False

def get_detail(k, path=None, allow_uncommitted=False, anomaly_sink=None):
    """Earliest valid row for k as {first_seen_written, first_seen_effective, committed_at, line}, or None.
    Committed rows: effective = max(written, commit date) (r5-3 clamp; never dropped for lateness). Uncommitted rows in
    a git-tracked file count only with allow_uncommitted=True (r5-2; same-pass writer before its commit)."""
    p = path or globals()["path"]()
    want = _k(k)
    dates = _commit_dates(p) if os.path.exists(p) else None
    best = None
    for n, e in _rows(p):
        if e.get("key") != want or not isinstance(e.get("first_seen"), str): continue
        fs = e["first_seen"][:10]
        if not _hand_floor_ok(want, fs): continue
        committed = dates.get(n) if dates is not None else None
        if dates is not None and committed is None and not allow_uncommitted: continue
        eff = max(fs, committed) if committed else fs
        late = bool(committed and committed > fs)
        # r6-1: reads are side-effect free; the late_commit anomaly is recorded only inside an active ledger pass
        # (whose commit then includes it) or via an explicit anomaly_sink.
        if late and (anomaly_sink is not None or _in_ledger_pass()): _late_commit(want, fs, committed, anomaly_sink)
        cand = {"first_seen_written": fs, "first_seen_effective": eff, "committed_at": committed, "line": n, "late": late}
        if best is None or eff < best["first_seen_effective"]: best = cand
    return best

def get(k, path=None, allow_uncommitted=False, anomaly_sink=None):
    """Earliest effective first_seen (ISO date) for k over valid rows, or None. See get_detail."""
    d = get_detail(k, path, allow_uncommitted, anomaly_sink)
    return d["first_seen_effective"] if d else None

def put(k, first_seen, path=None):
    """Record first_seen for k unless an earlier-or-equal valid value exists. Returns the effective (min) value.
    Refuses (ValueError) a first_seen earlier than a parseable, non-future hand_at."""
    if not _hand_floor_ok(k, first_seen):
        raise ValueError(f"first_seen {first_seen} is earlier than hand_at {_k(k)[2]}")
    p = path or globals()["path"]()
    with _lock:
        cur = get(k, p, allow_uncommitted=True)   # this pass's own pending rows count, so no duplicate appends
        if cur is not None and cur <= first_seen: return cur
        jsonl_store.append(p, {"key": _k(k), "first_seen": first_seen})
        return first_seen

def corrupt_lines(path=None):
    return jsonl_store.read(path or globals()["path"]())[1]
