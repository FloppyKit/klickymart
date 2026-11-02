-- M4 S7: takedown log (append-only: INSERT OR IGNORE only; no UPDATE/DELETE). Hash-only: no notice text, no claimant
-- name/email/address is stored. A notice is recorded after Matt reviews it by hand (valid = 1 or 0 at insert time).
CREATE TABLE IF NOT EXISTS takedown_notices (
  notice_hash TEXT PRIMARY KEY,   -- sha256 of the notice as received
  claimant_hash TEXT NOT NULL,    -- sha256 of the lower-cased claimant email
  pubkey TEXT NOT NULL,           -- the public Nostr key whose event(s) the notice targets
  valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tdn_pubkey ON takedown_notices (pubkey, valid, received_at);
-- One row per hidden event id. Hidden on our feed/relay output, the D1 index readers and the site.
CREATE TABLE IF NOT EXISTS takedown_hides (
  event_id TEXT NOT NULL,
  notice_hash TEXT NOT NULL,      -- one row per (event, notice): a later valid notice can hide a restored event again
  hidden_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, notice_hash)
);
