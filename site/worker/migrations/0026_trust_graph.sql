-- M4 S4: trust tiers from the Nostr social graph. All tables are append-only (INSERT OR IGNORE only; no UPDATE/DELETE in
-- code). Written by the daily trust job only when KM_TRUST_BUYS is on and KM_TRUST_SEED_NPUB is set.
-- A buy = one completed, validated 420 -> 421 -> 422 thread (422 accepted by the 420 author). Amounts/tips are not stored.
CREATE TABLE IF NOT EXISTS trust_buys (
  event_id TEXT PRIMARY KEY,     -- the 422 id
  store_domain TEXT NOT NULL,    -- domain claimed (store_claims, active) by the 421 author
  buyer_pubkey TEXT NOT NULL,    -- 420 author = 422 author; never a key of that store
  thread_root TEXT NOT NULL,     -- the 420 id
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tb_domain ON trust_buys (store_domain, buyer_pubkey);
-- A complaint = public kind-1 reply in a handshake thread: ["e",<420 id>,"","root"], ["km-complaint","1"], ["d-store",<domain>].
CREATE TABLE IF NOT EXISTS trust_complaints (
  event_id TEXT PRIMARY KEY,
  store_domain TEXT NOT NULL,
  author_pubkey TEXT NOT NULL,
  thread_root TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tc_domain ON trust_complaints (store_domain);
-- Hand-added by Matt only (wrangler d1 execute ... INSERT INTO trust_dismissals ...). No code path writes this table.
CREATE TABLE IF NOT EXISTS trust_dismissals (
  event_id TEXT PRIMARY KEY,     -- the complaint event id
  note TEXT,
  added_at INTEGER NOT NULL
);
-- Graph boundary: seed + 2 hops, read from our own relay. Only candidate pubkeys (buyers, complaint authors) are stored.
CREATE TABLE IF NOT EXISTS trust_graph_heads (
  graph_hash TEXT PRIMARY KEY,
  seed TEXT NOT NULL,
  hop1_count INTEGER NOT NULL,
  members INTEGER NOT NULL,
  built_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trust_graph_members (
  graph_hash TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  hop INTEGER NOT NULL,          -- 0 seed, 1 followed by seed, 2 followed by a hop-1 key
  PRIMARY KEY (graph_hash, pubkey)
);
