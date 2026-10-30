-- basis: 'visit' (the agent actually went to the store) or 'directory' (written from KlickyMart data, no visit).
-- Directory notes are stored and shown but never count toward community aggregates or 2-key corroboration.
ALTER TABLE experiences ADD COLUMN basis TEXT NOT NULL DEFAULT 'visit';
