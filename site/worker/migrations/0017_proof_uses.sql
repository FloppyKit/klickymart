-- R6-001: each payment proof (payment hash of a preimage, a zap receipt id, a 421 fulfillment id) is bound to the first
-- key that used it as a checked proof. Later keys citing the same proof get no verified weight (proof_status replayed-proof).
CREATE TABLE IF NOT EXISTS proof_uses (
  proof_key TEXT PRIMARY KEY,   -- "ph:<sha256(preimage)>" | "zap:<9735 id>" | "ful:<421 id>"
  pubkey TEXT NOT NULL,
  note_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);
