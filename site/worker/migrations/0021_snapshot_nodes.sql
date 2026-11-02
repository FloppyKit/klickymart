-- M4 S2: Merkle tree nodes for each snapshot head (append-only: rows are only ever INSERTed, never updated or deleted).
-- level 0 = leaf hashes in d order; the top level holds the root. Written once per daily head when KM_SNAPSHOT_DIGEST is on.
-- Observation only: no ranking, visibility or scoring code reads this table.
CREATE TABLE IF NOT EXISTS snapshot_nodes (
  sequence INTEGER NOT NULL,   -- snapshot_heads.sequence
  level INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (sequence, level, idx)
);
-- Leaf index → domain lookup for /open-store/proof (level-0 rows only).
CREATE TABLE IF NOT EXISTS snapshot_leaves (
  sequence INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  d TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  PRIMARY KEY (sequence, idx)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_leaves_d ON snapshot_leaves (sequence, d);
ALTER TABLE snapshot_heads ADD COLUMN merkle_leaf_count INTEGER;
