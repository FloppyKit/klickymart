#!/usr/bin/env python3
"""Repo-wide secret scan. Matches secret VALUES, not the word "secret", so guard code (nsec regex checks, NWC parse
errors) passes. Default: every git-tracked file from the repo root (any cwd). Explicit paths: scanned as given; a
missing path is an error. Prints file:line:rule only, never the value.

Per-line escape hatch: a line containing `secret-scan: allow` is not failed, but every rule it suppresses is printed as
`ALLOWED file:line:rule`, and the total is compared with the committed baseline (.secret-scan-allow-baseline at the repo
root): more allowed hits than the baseline fails. Binary files are printed as `SKIP file: binary`.
Exit 0 clean, 1 findings / allow count above baseline, 2 usage error (missing path)."""
import os, re, subprocess, sys

B32 = "[02-9ac-hj-np-z]"
B58 = "[1-9A-HJ-NP-Za-km-z]"
NB = r"(?<![A-Za-z0-9])"  # name boundary: unlike \b, '_' does not stop a match (CLOUDFLARE_API_TOKEN, secret_key)
W = "[A-Za-z0-9_]*"
SEP = r"[\"']?\s*[:=]\s*[\"'`]?"
# Names whose long-hex value is a secret (broad: a 32+ hex value next to any of these is never fine in the repo).
HEXNAME = rf"{NB}(?![A-Za-z0-9_]*(?i:pub))(?![A-Za-z0-9_]*(?i:npub)){W}(?:secret|sk|nsec|seckey|privkey|private_?key|key|seed|token|password|passwd|pwd|salt|macaroon){W}"
# Names whose ANY non-placeholder literal of 8+ chars is a secret (narrower: avoids cacheKey/seedUrl-style noise).
PWNAME = (rf"{NB}{W}(?:secret|password|passwd|pwd|private_?key|privkey|api[_-]?(?:key|token)|access[_-]?token"
          rf"|auth[_-]?token|submit_salt|mnemonic|seed[_-]?phrase){W}")
PLACEHOLDER = r"(?!REPLACE_AT_DEPLOY(?![A-Za-z0-9_\-+/=]))(?![<$])(?!(?:test|fake|dummy)[-_])(?!(?:x+|\*+|\.+|changeme|example|placeholder|your[_-])(?![A-Za-z0-9]{8}))"
PUBCTX = re.compile(r"(?i)pub(?:lic)?[ _-]?key|npub|pubkey|[\"']id[\"']\s*:|(?<![a-z])id(?![a-z])|_id(?![a-z])|hash|sha\d*|digest"
                    r"|txid|event|deletion|tombstone|author|signer|secp256k1")
RULES = [
    ("nsec-bech32", re.compile(rf"(?i)(?<![0-9a-z])nsec1{B32}{{58}}(?!{B32})")),
    ("nwc-uri-secret", re.compile(r"(?i)nostr\+walletconnect://[0-9a-f]{64}\?\S*?secret=[0-9a-f]{64}(?![0-9a-f])")),
    ("pem-private-key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")),
    ("bip32-xprv", re.compile(rf"(?<![A-Za-z0-9])[xtyzuv]prv{B58}{{100,}}")),
    ("lnd-macaroon", re.compile(r"(?i:0201036c6e64[0-9a-f]{40,})|AgEDbG5k[A-Za-z0-9+/_\-]{40,}")),
    ("bip39-mnemonic", re.compile(
        rf"(?i){NB}{W}(?:mnemonic|seed|phrase|words){W}{SEP}(?-i:[a-z]{{3,8}}(?:[ ,]+[a-z]{{3,8}}){{11,23}})(?![ ,]*[a-z])")),
    ("hex-key-assignment", re.compile(rf"(?i){HEXNAME}{SEP}(?:0x)?[0-9a-f]{{32,}}(?![0-9a-f])")),
    # Any quoted 64-hex is a key unless the line says it is public (pubkey, event id, hash, curve constant, ...).
    ("quoted-hex64", re.compile(r"(?i)[\"'`](?:0x)?[0-9a-f]{64}[\"'`]"), PUBCTX),
    ("account-id", re.compile(rf"(?i){NB}{W}account[_-]?id{W}[\"']?\s*[:=]\s*"
                              rf"(?:[\"'`]{PLACEHOLDER}[^\"'`\s{{}}()]{{6,}}[\"'`]|{PLACEHOLDER}[0-9a-f]{{6,}}(?![0-9a-z]))")),
    ("api-token-assignment", re.compile(
        rf"(?i){NB}{W}(?:api[_-]?(?:token|key)|auth_secret|submit_salt|cf_api_key|access[_-]?token){W}{SEP}"
        rf"{PLACEHOLDER}[A-Za-z0-9_\-+/=.]{{20,}}")),
    ("secret-literal-assignment", re.compile(
        rf"(?i){PWNAME}[\"']?\s*[:=]\s*(?:[\"'`]{PLACEHOLDER}[^\"'`\s{{}}()]{{8,}}[\"'`]|{PLACEHOLDER}[A-Za-z0-9_\-+/=.]{{8,}}\s*$)")),
]
EXCLUDE_EXACT = {"site/worker/src/fixture-data.ts"}
# SRI-pinned vendor bundles can't take an inline marker (it would change the hash); their known hits are allowed here
# instead, printed as ALLOWED and counted against the baseline like a marker.
FILE_ALLOW = {("site/public/vendor/nostr-tools-2.17.0.bundle.js", "quoted-hex64")}  # secp256k1 endo beta constant
ALLOW = "secret-scan: allow"
BASELINE = ".secret-scan-allow-baseline"

def _hits(line):
    return [r[0] for r in RULES if r[1].search(line) and not (len(r) > 2 and r[2].search(line))]

def _join(a, b):
    """Two physical lines as one logical value: "aa" +\\n "bb" -> "aabb"; x = \"\"\"\\nVALUE -> x = "VALUE"."""
    a, b = a.rstrip(), b.strip()
    m = re.search(r"([\"'`])\s*\+?\s*\\?$", a)
    if m and b[:1] in "\"'`": return a[:m.start()] + b[1:]
    if a.endswith(('"""', "'''", "`")) or re.search(r"[:=]\s*$", a): return a.rstrip("\"'` ") + ' "' + b
    return None

def scan_text(name, text, allowed=None):
    """Return ['name:line: rule', ...]. Suppressed hits go to `allowed` (a list) when given."""
    out, lines = [], text.splitlines()
    for i, line in enumerate(lines, 1):
        hits = _hits(line)
        if i < len(lines):
            j = _join(line, lines[i])
            if j is not None:
                hits += [r + "-multiline" for r in _hits(j) if r not in hits and r not in _hits(lines[i])]
        for rule in hits:
            hit = f"{name}:{i}: {rule}"
            if ALLOW in line or (name, rule) in FILE_ALLOW:
                if allowed is not None: allowed.append(hit)
            else: out.append(hit)
    return out

def decode(data):
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"): return data.decode("utf-16", "replace")
    if data[:3] == b"\xef\xbb\xbf": return data[3:].decode("utf-8", "replace")
    if b"\0" in data[:8192]: return None
    return data.decode("utf-8", "replace")

def main(argv, baseline=None):
    root = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    if argv:
        missing = [f for f in argv if not os.path.isfile(f)]
        if missing:
            for f in missing: print(f"ERROR {f}: no such file")
            return 2
        files, base = argv, ""
    else:
        if not root: print("ERROR not in a git repo"); return 2
        files = subprocess.run(["git", "-C", root, "ls-files", "-z"], capture_output=True, check=True).stdout.decode().split("\0")
        base = root
    found, allowed = [], []
    for f in files:
        if not f or f in EXCLUDE_EXACT or "node_modules/" in "/" + f: continue
        path = os.path.join(base, f) if base else f
        if os.path.islink(path) and not os.path.exists(path): continue
        if not os.path.exists(path):
            if argv: print(f"ERROR {f}: no such file"); return 2
            print(f"SKIP {f}: tracked but deleted in worktree"); continue
        if os.path.isdir(path): continue
        text = decode(open(path, "rb").read())
        if text is None: print(f"SKIP {f}: binary"); continue
        found += scan_text(f, text, allowed)
    for x in allowed: print("ALLOWED " + x)
    for x in found: print("FAIL " + x)
    rc = 1 if found else 0
    if baseline is None and not argv and root and os.path.exists(os.path.join(root, BASELINE)):
        baseline = int(open(os.path.join(root, BASELINE)).read().split()[0])
    if baseline is not None and len(allowed) > baseline:
        print(f"FAIL allow-marker count {len(allowed)} > baseline {baseline} ({BASELINE}); review and raise it in the same commit")
        rc = 1
    print(f"secret scan: {len(found)} finding(s), {len(allowed)} allowed")
    return rc

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
