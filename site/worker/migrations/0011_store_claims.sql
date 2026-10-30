-- Store claims by DNS TXT: _klickymart.<domain> TXT contains the owner's npub, plus a kind 1423 claim event signed by that key.
-- Revocation: a kind 1423 ["claim","revoke"] signed by the same key. A re-check that no longer finds the TXT marks dns-removed.
CREATE TABLE IF NOT EXISTS store_claims (
  domain TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'dns',
  status TEXT NOT NULL,          -- active | revoked | dns-removed
  txt TEXT,
  event_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_event_id TEXT,
  PRIMARY KEY (domain, pubkey)
);
CREATE INDEX IF NOT EXISTS i_claims_status ON store_claims(status, domain);
-- Crawl outcome note from the box crawler (POST /submit/queue/{id}/status, INGEST_TOKEN).
ALTER TABLE crawl_queue ADD COLUMN crawl_note TEXT;
