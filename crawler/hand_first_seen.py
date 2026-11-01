#!/usr/bin/env python3
"""Operator-side store of when this code first saw a hand override (n-2), so a rebuild that drops the record's
btc_grade_hand_first_seen cannot reset it and extend protection.

Append-only JSONL keyed by (domain, hand_by, hand_at normalized to UTC ISO seconds; "" when undated). A later write
never moves the value forward: get() is the MIN over all events. The record field is only a cache; btc_grade reads
this store first. Default path data/hand-first-seen.jsonl (TRACKED in git, append-only: enforced by
tests/test_tracked_ledgers.py and check_append_only.py); KM_HAND_FIRST_SEEN overrides (validated: data/ or a tmp dir).
Corrupt lines are skipped and counted."""
import datetime, threading
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

def _k(k): return list(k if isinstance(k, (list, tuple)) else key(*k))

def get(k, path=None):
    """Earliest first_seen (ISO date) recorded for key k, or None."""
    evs, _ = jsonl_store.read(path or globals()["path"]())
    vals = [e["first_seen"] for e in evs if e.get("key") == _k(k) and isinstance(e.get("first_seen"), str)]
    return min(vals) if vals else None

def put(k, first_seen, path=None):
    """Record first_seen for k unless an earlier-or-equal value exists. Returns the effective (min) value."""
    p = path or globals()["path"]()
    with _lock:
        cur = get(k, p)
        if cur is not None and cur <= first_seen: return cur
        jsonl_store.append(p, {"key": _k(k), "first_seen": first_seen})
        return first_seen

def corrupt_lines(path=None):
    return jsonl_store.read(path or globals()["path"]())[1]
