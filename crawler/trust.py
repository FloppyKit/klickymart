"""GO D7 (deterministic part): RDAP registration date per domain -> age bucket. Public RDAP via rdap.org (IANA bootstrap redirect).
429 -> back off, stop after 3 attempts. Scam flags are never inferred; only cited sources (none added by this script)."""
import json, sys, time, datetime, urllib.request, urllib.error, concurrent.futures as cf
from ua import UA
def iso(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def reg(d):
    parts = d.split("."); apex = ".".join(parts[-3:]) if parts[-2] in ("co", "com") and len(parts[-1]) == 2 else ".".join(parts[-2:])
    url = f"https://rdap.org/domain/{apex}"
    for a in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rdap+json"}), timeout=30) as r:
                j = json.loads(r.read()); src = r.geturl()
            ev = {e.get("eventAction"): e.get("eventDate") for e in j.get("events", [])}
            c = ev.get("registration")
            if not c: return {"domain": d, "apex": apex, "created": None, "src": src, "why": "rdap-no-registration-event", "checked_at": iso()}
            yrs = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(c.replace("Z", "+00:00"))).days / 365.25
            return {"domain": d, "apex": apex, "created": c[:10], "age_bucket": "<1y" if yrs < 1 else "1-5y" if yrs < 5 else "5y+", "src": src, "method": "api", "checked_at": iso()}
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(10 * (a + 1)); continue
            return {"domain": d, "apex": apex, "created": None, "why": f"rdap-http-{e.code}", "src": url, "checked_at": iso()}
        except Exception as e:
            time.sleep(3); last = type(e).__name__
    return {"domain": d, "apex": apex, "created": None, "why": "rdap-retries-exhausted", "src": url, "checked_at": iso()}
if __name__ == "__main__":
    ds = [json.loads(l)["d"] for l in open("out/records.v3.jsonl")] + [s["d"] for s in json.load(open("sites.v4new.json"))]
    with cf.ThreadPoolExecutor(6) as ex, open("out/trust.jsonl", "w") as f:
        for r in ex.map(reg, ds): f.write(json.dumps(r) + "\n"); f.flush()
