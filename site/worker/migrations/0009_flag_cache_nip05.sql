-- Cached anti-gaming flags (recomputed on ingest / POST; request paths read this).
CREATE TABLE IF NOT EXISTS note_flags (
  id TEXT PRIMARY KEY,
  d TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  level TEXT NOT NULL,
  weight REAL NOT NULL,
  tip_weight REAL,
  reasons_json TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS i_nf_d ON note_flags(d);
-- NIP-05 checks for keys that posted notes (domain fetch of /.well-known/nostr.json, robots.txt first).
CREATE TABLE IF NOT EXISTS nip05_checks (
  pubkey TEXT PRIMARY KEY,
  nip05 TEXT,
  domain TEXT,
  status TEXT NOT NULL,      -- verified | mismatch | robots-disallowed | gate-refused | error | none
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS i_n5_domain ON nip05_checks(domain, status);
