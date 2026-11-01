-- NIP-09 tombstones: an event id deleted by its author (kind 5). Later relay copies of that id by that pubkey are refused.
CREATE TABLE IF NOT EXISTS tombstones (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  deletion_id TEXT,
  deleted_at INTEGER NOT NULL
);
-- Relay self-test note of 2026-10-30, deleted by its author with kind 5 662445a3...
INSERT OR IGNORE INTO tombstones (id, pubkey, deletion_id, deleted_at) VALUES
  ('c09fb82f9fccb4d20fe6944533714f5d998593dbe33a5bbad99ed4b963b891bb', 'deb0e9c1c44df85bf86c6b1d3ba79697e65107c7d30e078ff11c45815af4c2dd', '662445a3ff22d26b50d17f9d28b5da248133263a5116ac697d99f56fb08d58dd', 1793379937); -- secret-scan: allow (public event ids / pubkey)
