#!/usr/bin/env python3
"""Shared append-only JSONL helpers for the tracked ledgers (hand_anomalies.py, hand_first_seen.py).
- default location: the repo's tracked data/ dir (Satoshi 2026-10-31: both ledgers are tracked in git; they hold only
  domain, author label and dates). Append-only is enforced by tests/test_tracked_ledgers.py and check_append_only.py.
- env path override is validated: it must resolve (symlinks included) under that data/ dir or a tmp dir, nothing else.
- corrupt lines are skipped and counted, never raised."""
import json, os, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")

def _roots():
    roots = {os.path.realpath(DATA), os.path.realpath(tempfile.gettempdir()), os.path.realpath("/tmp")}
    return [r.rstrip(os.sep) + os.sep for r in roots]

def resolve(env, default_name):
    """Path for a store: $env if set and safe, else data/<default_name>. Raises ValueError for an unsafe $env."""
    v = os.environ.get(env)
    if not v: return os.path.join(DATA, default_name)
    real = os.path.realpath(v)
    if not any(real.startswith(r) for r in _roots()):
        raise ValueError(f"{env}={v!r} resolves to {real!r}, outside the tracked data/ dir or a tmp dir; refused")
    return v

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
    os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
    with open(p, "a") as f: f.write(json.dumps(ev, separators=(",", ":")) + "\n")
