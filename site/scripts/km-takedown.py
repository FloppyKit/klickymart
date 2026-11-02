#!/usr/bin/env python3
"""M4 S7: turn a by-hand-reviewed takedown notice into append-only SQL for migration 0025's tables.

Usage: km-takedown.py decision.json > takedown.sql            (a notice)
       km-takedown.py --restore restore.json > restore.sql     (an accepted counter-notice)
restore.json: {"counter_file": "counter.eml", "notice_hash": "<64 hex from the notice SQL>", "event_ids": [...], "restored_at": 1793100000}   (prints SQL only; applying it is a separate, manual step)
decision.json: {"notice_file": "notice.eml", "claimant_email": "...", "pubkey": "<64 hex>",
                "event_ids": ["<64 hex>", ...], "valid": true, "received_at": 1793000000}
Only hashes of the notice and the claimant email are written. Invalid notices are logged (valid=0) and hide nothing.
Repeat offenders (3 valid notices / 365 days per pubkey) are enforced by the Worker (src/takedown.ts visibleSql)."""
import hashlib, json, re, sys

HEX64 = re.compile(r"^[0-9a-f]{64}$")

def sha(b: bytes) -> str: return hashlib.sha256(b).hexdigest()

def build_sql(d: dict, notice_bytes: bytes) -> str:
    pk = str(d.get("pubkey", "")).lower()
    ids = [str(x).lower() for x in d.get("event_ids", [])]
    if not HEX64.match(pk): raise ValueError("pubkey must be 64 hex")
    if not ids or not all(HEX64.match(x) for x in ids): raise ValueError("event_ids must be 64-hex ids")
    at = int(d["received_at"]); valid = 1 if d.get("valid") is True else 0
    nh = sha(notice_bytes); ch = sha(str(d["claimant_email"]).strip().lower().encode())
    out = [f"INSERT OR IGNORE INTO takedown_notices (notice_hash, claimant_hash, pubkey, valid, received_at) VALUES ('{nh}', '{ch}', '{pk}', {valid}, {at});"]
    if valid:
        out += [f"INSERT OR IGNORE INTO takedown_hides (event_id, notice_hash, hidden_at) VALUES ('{i}', '{nh}', {at});" for i in sorted(set(ids))]
    return "\n".join(out) + "\n"

def build_restore_sql(d: dict, counter_bytes: bytes) -> str:
    nh = str(d.get("notice_hash", "")).lower()
    ids = [str(x).lower() for x in d.get("event_ids", [])]
    if not HEX64.match(nh): raise ValueError("notice_hash must be 64 hex")
    if not ids or not all(HEX64.match(x) for x in ids): raise ValueError("event_ids must be 64-hex ids")
    at = int(d["restored_at"]); ch = sha(counter_bytes)
    return "".join(f"INSERT OR IGNORE INTO takedown_restores (event_id, notice_hash, counter_hash, restored_at) VALUES ('{i}', '{nh}', '{ch}', {at});\n" for i in sorted(set(ids)))

def main(argv):
    if len(argv) == 3 and argv[1] == "--restore":
        d = json.load(open(argv[2]))
        with open(d["counter_file"], "rb") as f: sys.stdout.write(build_restore_sql(d, f.read()))
        return
    d = json.load(open(argv[1]))
    with open(d["notice_file"], "rb") as f: nb = f.read()
    sys.stdout.write(build_sql(d, nb))

if __name__ == "__main__": main(sys.argv)
