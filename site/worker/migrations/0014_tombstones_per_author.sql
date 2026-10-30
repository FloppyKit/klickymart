-- KM-010: tombstones are per (event id, deleting author). A third party's kind 5 for an unseen id can no longer squat the
-- id and block the real author's own tombstone.
CREATE TABLE IF NOT EXISTS tombstones_v2 (
  id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  deletion_id TEXT,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (id, pubkey)
);
INSERT OR IGNORE INTO tombstones_v2 (id, pubkey, deletion_id, deleted_at) SELECT id, pubkey, deletion_id, deleted_at FROM tombstones;
DROP TABLE tombstones;
ALTER TABLE tombstones_v2 RENAME TO tombstones;
