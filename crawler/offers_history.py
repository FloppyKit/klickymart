"""GO D6: append-only price history from KlickyBot's own offer observations (never third-party history).
Usage: offers_history.py add out/offers.jsonl | stats.  DB: out/offers_history.sqlite"""
import json, sqlite3, sys, hashlib
db = sqlite3.connect("out/offers_history.sqlite")
db.execute("CREATE TABLE IF NOT EXISTS obs (offer_key TEXT, domain TEXT, url TEXT, price REAL, cur TEXT, stock TEXT, method TEXT, src TEXT, checked_at TEXT, PRIMARY KEY (offer_key, checked_at))")
def key(o): return hashlib.sha256(f'{o["domain"]}|{o["url"]}|{o["key"].get("sku") or o["key"].get("name")}'.encode()).hexdigest()[:20]
if sys.argv[1] == "add":
    n = 0
    for l in open(sys.argv[2]):
        o = json.loads(l)
        for x in (o["offers"] if "offers" in o else [o]):
            if not x.get("cur"): continue
            db.execute("INSERT OR IGNORE INTO obs VALUES (?,?,?,?,?,?,?,?,?)", (key(x), x["domain"], x["url"], x["price"], x["cur"], x.get("stock"), x["method"], x["src"], x["checked_at"])); n += 1
    db.commit(); print("added", n)
r = db.execute("SELECT COUNT(*), COUNT(DISTINCT offer_key), SUM(c>=2), SUM(changed) FROM (SELECT offer_key, COUNT(*) c, COUNT(DISTINCT price)>1 changed FROM obs GROUP BY offer_key)").fetchone()
print(f"observations {r[0]} offers {r[1]} with>=2 points {r[2]} price changed {r[3]}")
