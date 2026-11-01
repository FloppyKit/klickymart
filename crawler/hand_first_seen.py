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
lines are operator-local and trusted. get() is the min over valid rows only. This narrows forgery to "no earlier than
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

def _commit_dates(p):
    """{line_no: committer UTC date} for committed lines of a git-tracked file; None when not applicable/available."""
    if not shutil.which("git"):
        _warn("git unavailable: commit-date check on first_seen rows skipped"); return None
    d, f = os.path.split(os.path.abspath(p))
    try:
        if subprocess.run(["git", "-C", d, "ls-files", "--error-unmatch", f], capture_output=True).returncode != 0: return None
        r = subprocess.run(["git", "-C", d, "blame", "--line-porcelain", "--", f], capture_output=True, text=True)
    except OSError as e:
        _warn(f"git failed ({e}): commit-date check skipped"); return None
    if r.returncode != 0:
        _warn("git blame failed: commit-date check skipped"); return None
    out, cur, t = {}, None, None
    for l in r.stdout.splitlines():
        parts = l.split(" ")
        if len(parts) >= 3 and len(parts[0]) == 40 and parts[1].isdigit():
            cur = (parts[0], int(parts[2])); t = None
        elif l.startswith("committer-time ") and cur:
            t = int(l.split(" ", 1)[1])
            if cur[0] != "0" * 40:   # all-zero sha = not committed yet
                out[cur[1]] = datetime.datetime.fromtimestamp(t, datetime.timezone.utc).date().isoformat()
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

def get(k, path=None):
    """Earliest VALID first_seen (ISO date) for key k, or None (see p2-e in the module doc)."""
    p = path or globals()["path"]()
    want = _k(k)
    rows = [(n, e) for n, e in _rows(p) if e.get("key") == want and isinstance(e.get("first_seen"), str)]
    if not rows: return None
    dates = _commit_dates(p)
    vals = []
    for n, e in rows:
        fs = e["first_seen"][:10]
        if not _hand_floor_ok(want, fs): continue
        if dates and n in dates and fs < dates[n]: continue   # claims a date before the line was committed
        vals.append(fs)
    return min(vals) if vals else None
def put(k, first_seen, path=None):
    """Record first_seen for k unless an earlier-or-equal valid value exists. Returns the effective (min) value.
    Refuses (ValueError) a first_seen earlier than a parseable, non-future hand_at."""
    if not _hand_floor_ok(k, first_seen):
        raise ValueError(f"first_seen {first_seen} is earlier than hand_at {_k(k)[2]}")
    p = path or globals()["path"]()
    with _lock:
        cur = get(k, p)
        if cur is not None and cur <= first_seen: return cur
        jsonl_store.append(p, {"key": _k(k), "first_seen": first_seen})
        return first_seen

def corrupt_lines(path=None):
    return jsonl_store.read(path or globals()["path"]())[1]
