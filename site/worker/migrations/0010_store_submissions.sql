-- Path 3: community store submissions (POST /submit, MCP submit_store, signed kind 1423 notes).
-- Submitters can only set a domain, a category hint and a note; facts come from the gated crawl.
-- No raw IP addresses: ip_hash is a salted, week-bucketed SHA-256 prefix used only for rate limits.
CREATE TABLE IF NOT EXISTS store_submissions (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,            -- bare registrable domain (paths, queries and subdomains stripped)
  input_host TEXT,                 -- host as submitted (no path/query), for sub-domain collapse checks
  category TEXT,                   -- hint only
  note TEXT,                       -- links and affiliate junk stripped
  evidence_url TEXT,               -- same-site https URL, query stripped
  via TEXT NOT NULL,               -- post | mcp | nostr
  submitter_kind TEXT NOT NULL,    -- npub (signed) | agent (salted id) | anon
  submitter TEXT NOT NULL,         -- hex pubkey | agent:<salted id> | anon
  ip_hash TEXT,
  event_id TEXT,                   -- kind 1423 id when signed
  status TEXT NOT NULL,            -- queued | duplicate | rejected
  reason TEXT,
  flags_json TEXT NOT NULL DEFAULT '[]',
  review INTEGER NOT NULL DEFAULT 0, -- 1 = held for manual review (submitter reputation below -3)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS i_sub_domain ON store_submissions(domain, created_at);
CREATE INDEX IF NOT EXISTS i_sub_submitter ON store_submissions(submitter, created_at);
CREATE INDEX IF NOT EXISTS i_sub_ip ON store_submissions(ip_hash, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS i_sub_event ON store_submissions(event_id) WHERE event_id IS NOT NULL;
-- Gated-crawl queue. The Worker never crawls: the box crawler reads GET /submit/queue.ndjson and runs crawler/gate.py.
CREATE TABLE IF NOT EXISTS crawl_queue (
  domain TEXT PRIMARY KEY,
  first_submission_id TEXT NOT NULL,
  category_hint TEXT,
  submissions INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending', -- pending | review | crawled | refused
  flags_json TEXT NOT NULL DEFAULT '[]',
  queued_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS i_cq_state ON crawl_queue(state, queued_at);
