#!/usr/bin/env python3
"""Secret scan for the site job (run from site/). Matches secret VALUES, not the word "secret", so guard code such as
nsec regex checks and NWC parsing errors pass. Scans git-tracked files only; prints file:line:rule, never the value.
Per-line escape hatch: a line containing `secret-scan: allow` is skipped (use sparingly, review each one).
Exit 0 clean, 1 findings."""
import re, subprocess, sys

B32 = "[02-9ac-hj-np-z]"
RULES = [
    ("nsec-bech32", re.compile(rf"(?<![0-9a-z])nsec1{B32}{{58}}(?!{B32})")),
    ("nwc-uri-secret", re.compile(r"nostr\+walletconnect://[0-9a-fA-F]{64}\?\S*?secret=[0-9a-fA-F]{64}(?![0-9a-fA-F])")),
    ("hex-key-assignment", re.compile(
        r"(?i)\b(?:[a-z0-9_]*_)?(?:secret|sk|nsec|seckey|privkey|private_?key|sk_?hex)\b[\"']?\s*[:=]\s*[\"'`]?[0-9a-f]{64}(?![0-9a-f])")),
    ("api-token-assignment", re.compile(
        r"(?i)\b(?:api[_-]?token|account_id|auth_secret|submit_salt)\b[\"']?\s*[:=]\s*[\"'`]?(?!REPLACE_AT_DEPLOY)[A-Za-z0-9_\-]{24,}")),
]
EXCLUDE = ("node_modules/", "worker/src/fixture-data.ts")
ALLOW = "secret-scan: allow"

def scan_text(name, text):
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if ALLOW in line: continue
        for rule, rx in RULES:
            if rx.search(line): out.append(f"{name}:{i}: {rule}")
    return out

def main(argv):
    files = argv or subprocess.run(["git", "ls-files", "-z", "."], capture_output=True, check=True).stdout.decode().split("\0")
    found = []
    for f in files:
        if not f or f.startswith(EXCLUDE) or f in EXCLUDE: continue
        try: data = open(f, "rb").read()
        except (IsADirectoryError, FileNotFoundError): continue
        if b"\0" in data[:8192]: continue
        found += scan_text(f, data.decode("utf-8", "replace"))
    for x in found: print("FAIL " + x)
    print(f"secret scan: {len(found)} finding(s)")
    return 1 if found else 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
