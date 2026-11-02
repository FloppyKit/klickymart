-- 2026-11-01 D1 read spike: getCommunity() runs `SELECT ... FROM site_records WHERE d = ?` on every /merchant/<domain>
-- render. site_records' PK is (pubkey, d), so nothing leads on d and each call full-scanned the table (~484 rows).
CREATE INDEX IF NOT EXISTS i_site_records_d ON site_records(d);
