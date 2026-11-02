-- M4 S5: shipping policies read from stores' public pages by crawler/ship_parse.py (append-only: INSERT OR IGNORE only).
-- id = sha256(domain \0 {rules, ships_us}): an unchanged policy is stored once; a changed one is a new row. The Worker
-- uses the latest row per domain only for stores whose record has no ship_policy, and only when KM_DELIVERED_PRICE is on.
CREATE TABLE IF NOT EXISTS ship_policy_obs (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  rules_json TEXT NOT NULL,     -- ShipRule[] (site/worker/src/landed.ts), each with a verbatim quote; [] = unknown
  ships_us INTEGER,             -- 1 / 0 / NULL unknown
  src TEXT,                     -- the policy page URL (NULL when it could not be read)
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spo_domain ON ship_policy_obs (domain, checked_at);
