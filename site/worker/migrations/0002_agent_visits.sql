-- Daily aggregate agent visits. No IPs, no full user agents: only day, coarse family, endpoint, count.
CREATE TABLE IF NOT EXISTS agent_visits (
  day    TEXT NOT NULL,
  family TEXT NOT NULL,
  path   TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, family, path)
);
