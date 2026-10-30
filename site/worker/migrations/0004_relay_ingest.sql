-- Relay ingest (no IPs, no user agents). Events seen on public Nostr relays that concern indexed merchants.
CREATE TABLE IF NOT EXISTS nostr_events (
  id         TEXT PRIMARY KEY,
  kind       INTEGER NOT NULL,
  pubkey     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  d          TEXT,                 -- merchant domain this event concerns
  raw_json   TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  relays     TEXT NOT NULL         -- comma-separated relay URLs it was seen on
);
CREATE INDEX IF NOT EXISTS i_ne_kind_d ON nostr_events(kind, d);
CREATE INDEX IF NOT EXISTS i_ne_pk ON nostr_events(pubkey, first_seen);
-- Replaceable 31420 records: latest per (pubkey, d).
CREATE TABLE IF NOT EXISTS site_records (
  pubkey     TEXT NOT NULL,
  d          TEXT NOT NULL,
  id         TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  raw_json   TEXT NOT NULL,
  relays     TEXT NOT NULL,
  PRIMARY KEY (pubkey, d)
);
CREATE TABLE IF NOT EXISTS ingest_state (
  relay         TEXT PRIMARY KEY,
  last_seen     INTEGER NOT NULL DEFAULT 0,  -- max created_at seen (catch-up `since`)
  last_event_at INTEGER,                     -- wall clock of last event received
  last_ok_at    INTEGER,                     -- wall clock of last successful connect/EOSE
  last_error    TEXT,
  last_error_at INTEGER,
  events_total  INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'post';
ALTER TABLE reviews ADD COLUMN relays TEXT;
ALTER TABLE reviews ADD COLUMN proof_status TEXT;  -- verified-preimage | verified-zap | unverified-claim | null
