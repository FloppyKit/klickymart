-- M4 S3: store trust observations (append-only: INSERT OR IGNORE only; no UPDATE or DELETE anywhere in code).
-- id = sha256(domain \0 signal \0 value_json): the same value is stored once (first observation wins), a changed value
-- is a new row. Info + S4 tier inputs. Nothing ranks on this table until KM_TRUST_LABELS (S4) is on.
CREATE TABLE IF NOT EXISTS store_trust_obs (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  signal TEXT NOT NULL,        -- first_seen | domain_registered | return_policy | contact | reseller
  value_json TEXT NOT NULL,    -- JSON; null value = unknown (fetch error, disallowed, not found)
  evidence_url TEXT,           -- required when the value is non-null
  quote TEXT,                  -- verbatim text from evidence_url (return_policy, contact, reseller), else NULL
  method TEXT NOT NULL,        -- rdap | shopify-policy-page | contact-page | products-json | own-ledger
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sto_domain_signal ON store_trust_obs (domain, signal, observed_at);
