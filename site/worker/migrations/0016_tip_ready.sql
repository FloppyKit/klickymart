-- Tip-ready badge cache (display only; never read by ranking). One row per (pubkey, pay address).
CREATE TABLE IF NOT EXISTS tip_ready_cache (pubkey TEXT NOT NULL, addr TEXT NOT NULL, ok INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (pubkey, addr));
