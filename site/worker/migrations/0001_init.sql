CREATE TABLE records (
  d            TEXT PRIMARY KEY,
  name         TEXT,
  name_ev      TEXT,
  status       TEXT NOT NULL CHECK (status IN ('crawled','blocked-tos','agents-not-welcome','error')),
  status_code  INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  v            TEXT NOT NULL,
  cat_mask     INTEGER NOT NULL DEFAULT 0,
  ag           INTEGER,
  co           INTEGER,
  steps        INTEGER,
  guest        INTEGER,
  kyc          TEXT,
  tos          TEXT,
  tos_url      TEXT,
  tos_q        TEXT,
  btc          INTEGER,
  btc_any      INTEGER,
  btc_conf     TEXT,
  conf         TEXT,
  pay_any      INTEGER NOT NULL DEFAULT 0,
  pay_online   INTEGER NOT NULL DEFAULT 0,
  pay_instore  INTEGER NOT NULL DEFAULT 0,
  pay_unscoped INTEGER NOT NULL DEFAULT 0,
  pay_no       INTEGER NOT NULL DEFAULT 0,
  ar_mask      INTEGER NOT NULL DEFAULT 0,
  anw_type     TEXT,
  ease         INTEGER,
  search       TEXT NOT NULL,
  raw_json     TEXT NOT NULL,
  source       TEXT NOT NULL,
  event_id     TEXT,
  pubkey       TEXT,
  sig          TEXT,
  ingested_at  INTEGER NOT NULL
);
CREATE INDEX i_status ON records(status_code);
CREATE INDEX i_btc ON records(btc);
CREATE INDEX i_ts ON records(ts);
CREATE TABLE claims (
  d TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  nip05 TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (d, pubkey)
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
