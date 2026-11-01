-- M1: factual marks from the 420/421/422 validator (handshake.ts). Display/audit only: no ranking or visibility code reads this.
CREATE TABLE IF NOT EXISTS handshake_marks (
  event_id TEXT PRIMARY KEY,
  kind INTEGER NOT NULL,
  valid INTEGER NOT NULL,
  marks TEXT NOT NULL,      -- JSON array of ThreadMark strings
  checked_at INTEGER NOT NULL
);
