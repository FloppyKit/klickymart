-- M3 key records (v1, single key): pin / rotate / revoke for the result-signing key. Append-only.
-- Observation only: no scorer, ranking or visibility code reads this table.
CREATE TABLE IF NOT EXISTS km_key_records (
  id TEXT PRIMARY KEY,          -- sha256(JCS(body)) of the record body
  type TEXT NOT NULL,           -- km-key-pin | km-key-rotate | km-key-revoke
  body TEXT NOT NULL,           -- the full signed record JSON {id, body, sig | sig_old+sig_new}
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS km_key_records_no_update BEFORE UPDATE ON km_key_records BEGIN SELECT RAISE(ABORT, 'km_key_records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS km_key_records_no_delete BEFORE DELETE ON km_key_records BEGIN SELECT RAISE(ABORT, 'km_key_records is append-only'); END;
