#!/usr/bin/env python3
"""Sign each record as kind KIND_SITE (addressable, d=domain). Does NOT publish.
Usage: sign_events.py [records.jsonl] [--out PATH]   (default out: out/events.jsonl)
The key is loaded by path from $KM_CRAWLER_NSEC (default /home/box/secrets/klickymart/crawler.nsec) and never printed."""
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from kinds import KIND_SITE
from nostr_tags import tags_for, tags_match_content
from url_redact import redact  # KM-N01: strip captured tokens/query strings before signing

def main():
    from nostr_sdk import Keys, EventBuilder, Kind, Tag, Event
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="?", default=os.path.join(HERE, "out", "records.jsonl"))
    ap.add_argument("--out", default=os.path.join(HERE, "out", "events.jsonl"))
    a = ap.parse_args()
    with open(os.environ.get("KM_CRAWLER_NSEC", "/home/box/secrets/klickymart/crawler.nsec")) as f: keys = Keys.parse(f.read().strip())
    n = skipped = 0
    with open(a.out, "w") as out:
        for line in open(a.src):
            if not line.strip(): continue
            r = redact(json.loads(line))
            try: tags = tags_for(r)
            except ValueError as e: print(f"skip: {e}", file=sys.stderr); skipped += 1; continue
            ev = EventBuilder(Kind(KIND_SITE), json.dumps(r, separators=(",", ":"))).tags(
                [Tag.parse(x) for x in tags]).finalize_unsigned(keys.public_key()).sign(keys)
            out.write(ev.as_json() + "\n"); n += 1
    ok = 0
    for line in open(a.out):
        e = Event.from_json(line); j = json.loads(line)
        if (e.verify() and e.author().to_hex() == keys.public_key().to_hex() and e.kind().as_u16() == KIND_SITE
                and tags_match_content(j["tags"], json.loads(j["content"]))): ok += 1
    print(f"signed={n} skipped={skipped} verified={ok} author={keys.public_key().to_bech32()}")
    return 0 if ok == n else 1

if __name__ == "__main__": sys.exit(main())
