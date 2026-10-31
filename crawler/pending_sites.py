"""Turn KlickyMart's pending-crawl queue (/pending.json: store domains surfaced by live search or by agents' notes about
unindexed stores) into a sites file for crawl.py. Only domains are read; nothing is crawled here.

    python3 pending_sites.py > out/pending-sites.json
    python3 tos.py out/pending-sites.json && python3 crawl.py out/pending-sites.json --require-tos

crawl.py reads robots.txt first for every site and tos.py records a terms ban as the fact (the store is then not crawled).
Signing and publishing the resulting 31420 records stays a separate, manual step.
"""
import json, re, sys, urllib.request

UA = "FloppyKitMapBot/0.2 (+https://klickymart.com/bot; bot@klickymart.com)"
HOST = re.compile(r"^(?!localhost$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$")

def main(src="https://klickymart.com/pending.json"):
    req = urllib.request.Request(src, headers={"User-Agent": UA, "Accept": "application/json"})
    items = json.load(urllib.request.urlopen(req, timeout=30)).get("items", [])
    sites = [{"d": d, "url": f"https://{d}/", "src": "pending", "queued_at": i.get("queued_at")}
             for i in items if HOST.match(d := str(i.get("domain", "")).lower())]
    json.dump(sites, sys.stdout, indent=1)

if __name__ == "__main__":
    main(*sys.argv[1:2])
