-- M4 S3: domains seen in live Shopify Catalog results, for the next daily crawl batch (Matt 2026-11-01: domain only).
-- Separate from crawl_queue (0010, the gated store-submission queue with review states). No product, price or other
-- result data is stored (Shopify catalog usage guidelines). Append-only: INSERT OR IGNORE only.
CREATE TABLE IF NOT EXISTS live_seen_domains (
  domain TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  source TEXT NOT NULL          -- "live-catalog"
);
CREATE INDEX IF NOT EXISTS idx_lsd_first_seen ON live_seen_domains (first_seen_at);
