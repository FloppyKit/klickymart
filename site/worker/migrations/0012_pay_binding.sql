-- KM-001/KM-003: cache of LNURL-pay lookups (NIP-57): lightning address -> nostrPubkey that signs zap receipts.
CREATE TABLE IF NOT EXISTS lnurl_cache (
  lud16 TEXT PRIMARY KEY,
  nostr_pubkey TEXT,            -- null when the endpoint has no allowsNostr/nostrPubkey or the fetch failed
  checked_at INTEGER NOT NULL
);
