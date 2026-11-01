-- M3 OpenTimestamps proofs for key records (additive only; written only when KM_KEY_OTS is on).
-- One row per stamped record (key statement, revoke, revocation-key rotation). Proofs are public data, never secrets.
CREATE TABLE IF NOT EXISTS km_key_ots (
  rec_hash TEXT PRIMARY KEY,     -- km_key_records.rec_hash (the stamped digest)
  proofs_json TEXT NOT NULL,     -- JSON array of proofs, one per calendar that answered
  status TEXT NOT NULL,          -- pending | upgraded (upgraded = a calendar returned a proof into a block)
  updated_at INTEGER NOT NULL
);
-- OTS activation state (key 'activated' -> JSON {stmt, at}). Set once, inside the daily cron run that promotes a fresh
-- statement carrying notbefore; from then on every stored lifecycle record must carry notbefore.
CREATE TABLE IF NOT EXISTS km_key_ots_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
