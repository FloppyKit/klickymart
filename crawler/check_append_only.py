#!/usr/bin/env python3
"""Fail if a tracked append-only ledger lost or changed any byte between <base-ref> and the working tree.
Only whole-line appends are allowed (see check_bytes). Fails closed: an unresolvable base ref exits 2; a path absent at a
resolving base counts as new (all appends).

    python3 crawler/check_append_only.py <base-ref> [--paths data/hand-anomalies.jsonl ...]

Byte-identical duplicate rows are one row (set semantics): WARNING only. Consumers count distinct keys, not rows;
first_seen = earliest row per key.

Exit 0 ok, 1 violation, 2 usage/git error. Intended for CI."""
import os, subprocess, sys

DEFAULT_PATHS = ["data/hand-first-seen.jsonl", "data/hand-anomalies.jsonl"]

def _git(top, *a):
    return subprocess.run(["git", "-C", top, *a], capture_output=True)

def check_bytes(old, new):
    """None if new is a whole-line append of old, else the reason. p2-d: old must be empty or end with \\n; old lines must be
    an exact line-by-line prefix of new lines; no \\r anywhere."""
    if b"\r" in old: return "base contains \\r"
    if b"\r" in new: return "working copy contains \\r"
    if old and not old.endswith(b"\n"): return "base's last line has no trailing newline (it could be extended in place)"
    ol, nl = old.split(b"\n")[:-1] if old else [], new.split(b"\n")
    if len(nl) - 1 < len(ol): return f"{len(ol) - (len(nl) - 1)} line(s) removed"
    for i, (a, b) in enumerate(zip(ol, nl), 1):
        if a != b: return f"line {i} edited"
    return None

def main(argv):
    if not argv or argv[0].startswith("-"):
        print(__doc__, file=sys.stderr); return 2
    base, paths = argv[0], DEFAULT_PATHS
    if "--paths" in argv: paths = argv[argv.index("--paths") + 1:]
    try: top = subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"check_append_only: not a git work tree ({e})", file=sys.stderr); return 2
    # p2-c: fail closed. The base ref itself must resolve; only then may a path be "new" (absent at base).
    if _git(top, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}").returncode != 0:
        print(f"check_append_only: base ref {base!r} does not resolve (typo, shallow clone, rewritten history?)", file=sys.stderr); return 2
    bad = 0
    for p in paths:
        full = os.path.join(top, p)
        cur = open(full, "rb").read() if os.path.exists(full) else None
        if _git(top, "cat-file", "-e", f"{base}:{p}").returncode != 0:
            if cur is not None and (b"\r" in cur):
                print(f"FAIL {p}: new file contains \\r"); bad += 1
            else: print(f"ok   {p}: new since {base}")
            continue
        r = _git(top, "show", f"{base}:{p}")
        if r.returncode != 0:
            print(f"FAIL {p}: git show {base}:{p} failed: {r.stderr.decode(errors='replace').strip()}"); bad += 1; continue
        if cur is None: print(f"FAIL {p}: deleted (was {len(r.stdout)} bytes at {base})"); bad += 1; continue
        why = check_bytes(r.stdout, cur)
        if why: print(f"FAIL {p}: {why} vs {base}"); bad += 1
        else:
            print(f"ok   {p}: +{len(cur) - len(r.stdout)} bytes appended")
            ln = cur.split(b"\n")[:-1]; d = len(ln) - len(set(ln))
            if d: print(f"WARNING {p}: {d} byte-identical duplicate row(s); set semantics, counted once (not a failure)")
    return 1 if bad else 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
