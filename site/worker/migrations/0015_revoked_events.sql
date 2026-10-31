-- KM-002 follow-up: revoke facilitated 421s signed before the pause so they can no longer lift a store's tier.
CREATE TABLE IF NOT EXISTS revoked_events (id TEXT PRIMARY KEY, reason TEXT NOT NULL, revoked_at INTEGER NOT NULL);
INSERT OR IGNORE INTO revoked_events (id, reason, revoked_at)
  SELECT id, 'facilitated-before-pause', CAST(strftime('%s','now') AS INTEGER) FROM nostr_events
  WHERE kind = 421 AND pubkey = '138fdf32b9275166bf20083f97e1fa31a6c271dd0c15725a26258084c3b52dcb';
UPDATE reviews SET proof_status = 'facilitated-unverified'
  WHERE fulfillment IN (SELECT id FROM revoked_events) AND IFNULL(proof_status, '') LIKE 'verified%';
UPDATE experiences SET proof_status = 'facilitated-unverified'
  WHERE IFNULL(proof_status, '') LIKE 'verified%' AND EXISTS (SELECT 1 FROM revoked_events r WHERE instr(experiences.raw_json, r.id) > 0);
