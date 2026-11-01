#!/usr/bin/env python3
"""Shared append-only JSONL helpers for operator-local ledgers (hand_anomalies.py, hand_first_seen.py).
- env path override is validated: it must resolve (symlinks included) under crawler/out/ or a tmp dir.
- corrupt lines are skipped and counted, never raised."""
import json, os, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

def _roots():
    roots = {os.path.realpath(OUT), os.path.realpath(tempfile.gettempdir()), os.path.realpath("/tmp")}
    return [r.rstrip(os.sep) + os.sep for r in roots]

def resolve(env, default_name):
    """Path for a store: $env if set and safe, else crawler/out/<default_name>. Raises ValueError for an unsafe $env."""
    v = os.environ.get(env)
    if not v: return os.path.join(OUT, default_name)
    real = os.path.realpath(v)
    if not any(real.startswith(r) for r in _roots()):
        raise ValueError(f"{env}={v!r} resolves to {real!r}, outside crawler/out/ or a tmp dir; refused")
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
