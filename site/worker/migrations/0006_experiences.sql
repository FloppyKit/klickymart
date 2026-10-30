-- Structured "shopping experience" notes (kind 422 with experience tags) and unstructured kind-1 #klickymart notes.
-- Public Nostr notes cached from relays or POST /reviews. Never overwrites crawl data. No IPs.
CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY, kind INTEGER NOT NULL, d TEXT NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
  structured INTEGER NOT NULL,            -- 1 = kind 422 with experience tags; 0 = kind 1 #klickymart note
  depth TEXT, guest TEXT, account_required TEXT, pay_used TEXT, pay_offered TEXT, btc_route TEXT,
  tax_before TEXT, ship_before TEXT, price REAL, shipping REAL, tax REAL, total REAL, currency TEXT, region TEXT,
  steps_n INTEGER, duration_s INTEGER, blocker TEXT, walls TEXT, agent TEXT, delivered TEXT, delivery_days INTEGER,
  rating5 REAL, product TEXT, proof TEXT, proof_status TEXT, content TEXT NOT NULL, raw_json TEXT NOT NULL,
  source TEXT NOT NULL, relays TEXT, received_day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS i_exp_d ON experiences(d, created_at);
CREATE INDEX IF NOT EXISTS i_exp_pk ON experiences(pubkey, received_day);
