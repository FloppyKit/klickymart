#!/usr/bin/env python3
"""CI check for the append-only ledgers (called by .github/workflows/site.yml, job `ledgers`).

Base selection:
  pull_request          -> the PR base sha
  push, not main        -> --before if it is a real sha, else (all zeros = new branch) merge-base with --main-ref
  push, main            -> --before must resolve AND be an ancestor of HEAD (git merge-base --is-ancestor); if it is
                           unreachable or not an ancestor (force-push), exit 2 WITHOUT scanning. Same ancestor rule for
                           branch pushes and for the PR base (the PR merge ref's first parent is the base sha, so a
                           non-ancestor base means a stale/rewritten base; fail closed, a re-run fixes a race);
                           then the WHOLE ledger history reachable from HEAD is scanned (a cancelled/skipped run can't hide
                           a rewrite)
Scan: every commit in the range that touched a ledger is checked against ITS OWN parent(s) only:
  - one parent: the parent's file must be an exact line prefix of the child's (check_append_only.check_bytes)
  - merge: the first parent's file must be an exact line prefix of the result (no reordering, so git blame keeps each
    row's commit date); every other parent's rows must be present after it (multiset); extra rows are appends.
Why sound: rows in the base are in every first commit of the range's parents; by induction each step keeps all of its
parents' rows (prefix, or multiset superset for merges), so no row reachable from base is ever edited or dropped by HEAD.
A union merge result (base+M+S) contains both base+M and base+S, so normal merges pass.
TODO(scale): the main scan walks all ledger-touching commits (unbounded but small: one per pass). If it grows, checkpoint
on a signed/protected "last verified" tag once v9.2 operator signing lands.
Exit: 0 ok, 1 violation, 2 usage/unresolvable base."""
import argparse, collections, subprocess, sys
from check_append_only import check_bytes

PATHS = ["data/hand-first-seen.jsonl", "data/hand-anomalies.jsonl"]
ZERO = "0" * 40

def git(*a, text=True):
    return subprocess.run(["git", *a], capture_output=True, text=text, timeout=60)

def resolves(ref):
    return git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode == 0

def blob(rev, path):
    if not git("ls-tree", "--name-only", rev, "--", path).stdout.strip(): return b""
    r = git("show", f"{rev}:{path}", text=False)
    if r.returncode != 0: raise RuntimeError(f"git show {rev}:{path} failed")
    return r.stdout

def check_merge(parents_bytes, child):
    """First parent's file must be an exact line prefix of the result (no reorder, so blame keeps each row's date);
    every other parent's rows must appear after that prefix (multiset); anything else is an append."""
    why = check_bytes(parents_bytes[0], child)
    if why: return f"first parent not an exact prefix: {why}"
    have = collections.Counter(child[len(parents_bytes[0]):].split(b"\n")[:-1])
    for i, pb in enumerate(parents_bytes[1:], 2):
        need = collections.Counter(pb.split(b"\n")[:-1] if pb else [])
        # rows parent i shares with parent 1 are already in the prefix
        need -= collections.Counter(parents_bytes[0].split(b"\n")[:-1] if parents_bytes[0] else [])
        missing = need - have
        if missing: return f"merge dropped or edited {sum(missing.values())} row(s) of parent {i}"
    return None

def is_ancestor(base):
    return git("merge-base", "--is-ancestor", base, "HEAD").returncode == 0

def scan(rng):
    """rng: rev-list arguments. Returns list of violation strings."""
    out = git("rev-list", "--full-history", "--parents", *rng, "--", *PATHS)
    if out.returncode != 0: raise RuntimeError(f"git rev-list failed: {out.stderr.strip()}")
    bad = []
    for line in out.stdout.splitlines():
        c, *parents = line.split()
        for p in PATHS:
            child = blob(c, p)
            pbs = [blob(x, p) for x in parents]
            if len(pbs) <= 1:
                why = check_bytes(pbs[0] if pbs else b"", child)
            else:
                why = check_merge(pbs, child)
            if why: bad.append(f"{c[:12]} {p}: {why}")
    return bad

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", required=True); ap.add_argument("--ref", required=True)
    ap.add_argument("--before", default=""); ap.add_argument("--pr-base", default="")
    ap.add_argument("--main-ref", default="origin/main")
    a = ap.parse_args(argv)
    if a.event == "pull_request":
        base = a.pr_base
        if not base or not resolves(base) or not is_ancestor(base):
            print(f"FAIL: PR base {base!r} does not resolve or is not an ancestor of HEAD; no scan"); return 2
        rng = [f"{base}..HEAD"]
    elif a.ref != "refs/heads/main":
        if a.before and a.before != ZERO:
            base = a.before
        else:
            mb = git("merge-base", a.main_ref, "HEAD")
            if mb.returncode != 0: print(f"FAIL: no merge-base with {a.main_ref}"); return 2
            base = mb.stdout.strip()
        if not resolves(base) or not is_ancestor(base):
            print(f"FAIL: base {base!r} does not resolve or is not an ancestor of HEAD (force-push?); no scan"); return 2
        rng = [f"{base}..HEAD"]
    else:
        base = a.before if a.before and a.before != ZERO else None
        if base and (not resolves(base) or not is_ancestor(base)):
            print(f"FAIL: before {base!r} is unreachable or not an ancestor of HEAD (force-push rewrote main?); no scan")
            return 2
        rng = ["HEAD"]   # whole reachable ledger history, each commit vs its own parents
    print(f"append-only scan: event {a.event} ref {a.ref} base {base} range {' '.join(rng)}")
    try: bad = scan(rng)
    except (RuntimeError, subprocess.TimeoutExpired) as e: print(f"FAIL: {e}"); return 2
    for b in bad: print("FAIL " + b)
    if not bad: print("ok   all ledger commits are appends of their parents")
    return 1 if bad else 0

if __name__ == "__main__": sys.exit(main())
