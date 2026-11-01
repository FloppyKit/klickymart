#!/usr/bin/env python3
"""Sign each record as kind 31420 (addressable, d=domain). Writes out/events.jsonl. Does NOT publish."""
import json, os, sys
from nostr_sdk import Keys, EventBuilder, Kind, Tag, Event, NostrSigner
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from url_redact import redact  # KM-N01: strip captured session/auth tokens and query strings before signing
HERE = os.path.dirname(os.path.abspath(__file__))
keys = Keys.parse(open(os.environ.get("KM_CRAWLER_NSEC", "/home/box/secrets/klickymart/crawler.nsec")).read().strip())
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "out", "records.jsonl")
SIGNER = keys
dst = os.path.join(HERE, "out", "events.jsonl")
NS = "nip-xx/crawl"
def tags_for(r):
    t = [["d", r["d"]], ["r", r["d"]], ["L", NS], ["v", r.get("v", "0.2")]]
    for c in r.get("cat", []): t.append(["t", c])
    if r.get("ag") is not None: t.append(["l", f"ag{r['ag']}", NS])
    if r.get("btc") is not None: t.append(["l", f"btc{r['btc']}", NS])
    if r.get("btc_any"): t.append(["l", "btc_any", NS])
    for p in r.get("pay", []): t.append(["l", f"pay:{p}", NS])
    for p in r.get("pay_no", []): t.append(["l", f"no:{p}", NS])
    for a in {x["c"] for x in r.get("ar", [])}: t.append(["l", f"ar:{a}", NS])
    return t
n = 0
with open(dst, "w") as out:
    for line in open(src):
        if not line.strip(): continue
        r = redact(json.loads(line))
        ev = EventBuilder(Kind(31420), json.dumps(r, separators=(",", ":"))).tags([Tag.parse(x) for x in tags_for(r)]).finalize_unsigned(keys.public_key()).sign(SIGNER)
        out.write(ev.as_json() + "\n"); n += 1
# verify from disk
ok = 0
for line in open(dst):
    e = Event.from_json(line)
    if e.verify() and e.author().to_hex() == keys.public_key().to_hex() and e.kind().as_u16() == 31420: ok += 1
print(f"signed={n} verified={ok} author={keys.public_key().to_bech32()}")
