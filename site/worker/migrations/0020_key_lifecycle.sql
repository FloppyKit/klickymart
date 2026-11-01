-- M3 signing-key lifecycle (additive only). Append-only store of KlickyMart key records: key statements, revokes and
-- revocation-key rotations. Every row is self-verifying JSON (public keys and signatures only, never a secret key).
-- Rows are never updated or deleted: a revoke, once stored, survives redeploys and restores.
CREATE TABLE IF NOT EXISTS km_key_records (
  id TEXT PRIMARY KEY,           -- sha256 over kind + "\n" + canonical signed record (payload + signatures)
  rec_hash TEXT NOT NULL,        -- record hash (sha256 over domain + canonical payload)
  kind TEXT NOT NULL,            -- statement | revoke | revkey_rotate | staged_statement (not in the lineage until the daily cron promotes it)
  body_json TEXT NOT NULL,       -- the full signed record
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kkr_kind ON km_key_records (kind);
