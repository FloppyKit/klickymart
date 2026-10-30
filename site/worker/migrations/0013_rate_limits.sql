-- KM-008: atomic rate-limit counters. One row per (limit key, window); the take is a single INSERT .. ON CONFLICT .. WHERE
-- n < limit RETURNING statement, so parallel requests cannot all read the same old count.
CREATE TABLE IF NOT EXISTS rate_limits (
  k   TEXT PRIMARY KEY,
  n   INTEGER NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS i_rate_limits_exp ON rate_limits(exp);
