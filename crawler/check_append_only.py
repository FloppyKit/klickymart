#!/usr/bin/env python3
"""Fail if a tracked append-only ledger lost or changed any byte between <base-ref> and the working tree.
Only appends are allowed: the working copy must start with the base-ref bytes exactly. A file absent at base-ref passes.

    python3 crawler/check_append_only.py <base-ref> [--paths data/hand-anomalies.jsonl ...]

Exit 0 ok, 1 violation, 2 usage/git error. Intended for CI."""
import os, subprocess, sys

DEFAULT_PATHS = ["data/hand-first-seen.jsonl", "data/hand-anomalies.jsonl"]

def main(argv):
    if not argv or argv[0].startswith("-"):
        print(__doc__, file=sys.stderr); return 2
    base, paths = argv[0], DEFAULT_PATHS
    if "--paths" in argv: paths = argv[argv.index("--paths") + 1:]
    try: top = subprocess.run(["git", "rev-parse", "--show-toplevel"], check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"check_append_only: not a git work tree ({e})", file=sys.stderr); return 2
    bad = 0
    for p in paths:
        r = subprocess.run(["git", "-C", top, "show", f"{base}:{p}"], capture_output=True)
        if r.returncode != 0: print(f"ok   {p}: not at {base}"); continue
        full = os.path.join(top, p)
        cur = open(full, "rb").read() if os.path.exists(full) else None
        if cur is None: print(f"FAIL {p}: deleted (was {len(r.stdout)} bytes at {base})"); bad += 1
        elif not cur.startswith(r.stdout):
            i = next((n for n, (a, b) in enumerate(zip(r.stdout, cur)) if a != b), min(len(r.stdout), len(cur)))
            line = r.stdout[:i].count(b"\n") + 1
            print(f"FAIL {p}: removed or edited content at byte {i} (line {line}) vs {base}"); bad += 1
        else: print(f"ok   {p}: +{len(cur) - len(r.stdout)} bytes appended")
    return 1 if bad else 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
