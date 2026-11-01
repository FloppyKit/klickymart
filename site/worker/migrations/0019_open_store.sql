-- M2 open store (additive only). Endpoint binding evidence + per-store-key state, and signed snapshot heads.
-- Observation only: no ranking, visibility or scoring code reads these tables.
CREATE TABLE IF NOT EXISTS endpoint_binding_events (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  outcome TEXT NOT NULL,        -- accepted | conflict | revoked (ignored events are never stored)
  raw_json TEXT NOT NULL,       -- the signed event, kept as evidence (relays may drop older addressable versions)
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ebe_pubkey_version ON endpoint_binding_events (pubkey, version);
CREATE TABLE IF NOT EXISTS endpoint_binding_state (
  pubkey TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  ignored_count INTEGER NOT NULL DEFAULT 0,   -- post-revoke, future-dated and stale-replay events: counted, not stored
  last_ignored_hash TEXT,                     -- event id (hash) of the last ignored event
  updated_at INTEGER NOT NULL
);
-- One sequence per KlickyMart root identity, strictly increasing. Written by the snapshot step (M4); M2 only reads it.
CREATE TABLE IF NOT EXISTS snapshot_heads (
  sequence INTEGER PRIMARY KEY,
  snapshot_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  prev_head TEXT
);
