-- GO D9: on-demand recheck results (robots + home status). 1 per domain per 10 min, 60 per hour globally.
CREATE TABLE IF NOT EXISTS rechecks (
  domain TEXT NOT NULL,
  ts INTEGER NOT NULL,
  robots_status INTEGER,
  robots_allows INTEGER,
  robots_line TEXT,
  home_status INTEGER,
  verdict TEXT NOT NULL,
  PRIMARY KEY (domain, ts)
);
CREATE INDEX IF NOT EXISTS rechecks_ts ON rechecks (ts);
