"""Sign ONE kind 5 deletion (NIP-09) for the given event ids with the crawler key. Does NOT publish; key never printed.
Usage: sign_deletion.py IDS.txt OUT.jsonl "reason"   (e-tags only, plus k=31420; no a-tag so newer replacements survive)"""
import json, os, sys
from nostr_sdk import Keys, EventBuilder, Kind, Tag, Event
HERE = os.path.dirname(os.path.abspath(__file__))
ids = [l.strip() for l in open(sys.argv[1]) if l.strip()]
assert all(len(i) == 64 for i in ids)
with open(os.environ.get("KM_CRAWLER_NSEC", "/home/box/secrets/klickymart/crawler.nsec")) as f: keys = Keys.parse(f.read().strip())
tags = [Tag.parse(["e", i]) for i in ids] + [Tag.parse(["k", "31420"])]
ev = EventBuilder(Kind(5), sys.argv[3]).tags(tags).finalize_unsigned(keys.public_key()).sign(keys)
assert Event.from_json(ev.as_json()).verify()
open(sys.argv[2], "w").write(ev.as_json() + "\n")
print(json.dumps({"id": ev.id().to_hex(), "e_tags": len(ids), "author": keys.public_key().to_hex()}))
