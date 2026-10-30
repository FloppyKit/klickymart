-- Kind 422 merchant reviews submitted as signed Nostr events. No IPs, no user agents.
CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,          -- nostr event id
  d            TEXT NOT NULL,             -- merchant domain (from the a/r tag)
  pubkey       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  rating       INTEGER NOT NULL,
  rating_max   INTEGER NOT NULL,
  attempt      TEXT NOT NULL,             -- browse | cart | checkout | paid
  pay          TEXT,                      -- payment method code used, if any
  fulfillment  TEXT,                      -- 421 event id this 422 accepts, if any
  proof        TEXT,                      -- zap | preimage | cashu | null
  content      TEXT NOT NULL,
  raw_json     TEXT NOT NULL,
  received_day TEXT NOT NULL              -- UTC day received (for rate limits)
);
CREATE INDEX IF NOT EXISTS i_reviews_d ON reviews(d, created_at);
CREATE INDEX IF NOT EXISTS i_reviews_pk_day ON reviews(pubkey, received_day);
CREATE INDEX IF NOT EXISTS i_reviews_day ON reviews(received_day);
