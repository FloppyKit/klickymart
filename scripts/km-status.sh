#!/bin/bash
# km-status.sh: the ONE status path for KlickyMart (read-only; no Cloudflare/GitHub writes).
# Paste its output verbatim before any "done", "fixed", "deployed" or "nothing failed" claim.
# Network calls each capped at 2 min. Never prints tokens/keys; output is scrubbed for token/nsec/64-hex.
#
# Free-tier DAILY limits (Workers Free plan; reset 00:00 UTC), read 2026-10-31 from:
#   Workers requests 100,000/day        https://developers.cloudflare.com/workers/platform/limits/
#   DO requests 100,000/day; DO duration 13,000 GB-s/day
#                                        https://developers.cloudflare.com/durable-objects/platform/pricing/
#   D1 rows read 5,000,000/day; D1 rows written 100,000/day
#                                        https://developers.cloudflare.com/d1/platform/pricing/
# Budget = 50% of each (chuck.md guardrail 3). Over 80% => km-deploy rollback only.
# Log prune (7 days, move to logs/_old, never delete): scripts/km-prune.sh
REPO=${KM_REPO:-/workspace/klickymart-public}
ALLOWED_WORKERS=${KM_ALLOWED_WORKERS:-"klickymart klickymart-production"}
PROD=${KM_PROD_WORKER:-klickymart-production}
export TZ=America/Chicago
scrub(){ sed -E 's/nsec1[0-9a-z]+/nsec1[REDACTED]/g; s/\b[0-9a-fA-F]{64}\b/[HEX64-REDACTED]/g; s/(Bearer|token["=: ]+)[A-Za-z0-9._-]{12,}/\1 [REDACTED]/Ig'; }
T="timeout 120"
main(){
echo "== km-status $(date '+%Y-%m-%d %H:%M %Z')"
cd "$REPO" || exit 1
HEAD=$(git rev-parse HEAD); echo "repo=$REPO branch=$(git rev-parse --abbrev-ref HEAD) HEAD=${HEAD:0:7} dirty_paths=$(git status --porcelain | wc -l)"
SLUG=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')

echo; echo "== Last 10 GitHub runs ($SLUG)"
if command -v gh >/dev/null && $T gh auth status >/dev/null 2>&1; then
  $T gh run list -R "$SLUG" --limit 10 --json headSha,workflowName,status,conclusion,createdAt,headBranch 2>&1 | python3 -c '
import json,sys,datetime,zoneinfo
z=zoneinfo.ZoneInfo("America/Chicago")
for r in json.load(sys.stdin):
  t=datetime.datetime.fromisoformat(r["createdAt"].replace("Z","+00:00")).astimezone(z)
  sha,wf,st,co,br=r["headSha"][:7],r["workflowName"],r["status"],r["conclusion"] or "-",r["headBranch"]
  print(f"  {sha}  {wf:<20} {st}/{co:<10} {t:%Y-%m-%d %H:%M} CT  {br}")'
  echo "  CI on HEAD ${HEAD:0:7}:"; $T gh run list -R "$SLUG" --commit "$HEAD" --json workflowName,status,conclusion 2>&1 | python3 -c '
import json,sys
r=json.load(sys.stdin)
ok=bool(r) and all(x["status"]=="completed" and x["conclusion"]=="success" for x in r)
for x in r: print("    %s: %s/%s" % (x["workflowName"],x["status"],x["conclusion"]))
print("  CHECK ci_green_on_head:", "PASS" if ok else "FAIL" + (" (no runs)" if not r else ""))'
else echo "  GitHub: unavailable (gh missing or not authenticated)"; echo "  CHECK ci_green_on_head: FAIL (unverifiable)"; fi

echo; echo "== Cloudflare"
cd "$REPO/site"
ACC=$($T npx wrangler whoami 2>/dev/null | grep -oE '\b[0-9a-f]{32}\b' | head -1)
cf(){ printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" | $T curl -s -H @- "$@"; }   # token via stdin, never argv
if [ -z "$ACC" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then echo "  Cloudflare: unavailable (no account/credentials)"; return; fi
echo "-- Deployed version vs HEAD ($PROD)"
$T npx wrangler deployments list --name "$PROD" 2>&1 | grep -E 'Created|Author|Source|Message|Version\(s\)|^\s+[0-9a-f-]{36}' | tail -8 | sed 's/^/  /'
MSG=$($T npx wrangler deployments list --name "$PROD" --json 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); d=d[-1] if isinstance(d,list) else d
print((d.get("annotations") or {}).get("workers/message","") or "", "|", ",".join(v.get("version_id","") for v in d.get("versions",[])), "|", d.get("created_on",""))' 2>/dev/null)
echo "  latest deployment: $MSG"
VTAG=$($T npx wrangler versions list --name "$PROD" --json 2>/dev/null | python3 -c '
import json,sys
v=json.load(sys.stdin); v=v[-1] if v else {}
a=v.get("annotations") or {}; m=v.get("metadata") or {}
print(a.get("workers/tag") or "", a.get("workers/message") or "", m.get("source") or "")' 2>/dev/null)
echo "  latest version annotations: ${VTAG:-none}"
if echo "$MSG $VTAG" | grep -q "${HEAD:0:7}"; then echo "  CHECK deployed_eq_head: PASS"; else echo "  CHECK deployed_eq_head: FAIL (no deployment/version tagged with ${HEAD:0:7}; km-deploy does not tag versions with the sha yet)"; fi

echo "-- Live crons on $PROD (from Cloudflare, not repo)"
cf "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/$PROD/schedules" | python3 -c '
import json,sys
d=json.load(sys.stdin); s=(d.get("result") or {}).get("schedules",[]) if d.get("success") else None
if s is None: print("  crons: unavailable", d.get("errors")); sys.exit()
bad=[]
for x in s:
  c=x["cron"]; print("  cron:", c); f=c.split()
  if not (f[0].isdigit() and f[1].isdigit()): bad.append(c)
print("  CHECK daily_cron_only:", "PASS" if s and not bad else "FAIL", ("sub-daily: %s" % bad) if bad else "")'

echo "-- Workers in account"
cf "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts" | python3 -c '
import json,sys
allowed=sys.argv[1].split()
d=json.load(sys.stdin)
if not d.get("success"): print("  workers: unavailable", d.get("errors")); sys.exit()
other=[]
for s in d["result"]:
  flag="" if s["id"] in allowed else "  <-- NOT klickymart"
  if flag: other.append(s["id"])
  print("  ", s["id"], s.get("modified_on",""), flag)
print("  CHECK one_klickymart_worker:", "PASS" if not other else "FAIL (%d other Workers in shared account: %s)" % (len(other), ", ".join(other)))' "$ALLOWED_WORKERS"

echo "-- Usage today (UTC day, account-wide) vs 50% of free-tier daily limits"
DAY=$(date -u +%Y-%m-%d)
Q='{"query":"query($a:String!,$d:Date!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){w:workersInvocationsAdaptive(limit:10000,filter:{date:$d}){sum{requests}} o:durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{date:$d}){sum{requests}} p:durableObjectsPeriodicGroups(limit:10000,filter:{datetimeMinute_geq:$s,datetimeMinute_lt:$e}){sum{activeTime}} q:d1AnalyticsAdaptiveGroups(limit:10000,filter:{date:$d}){sum{rowsRead rowsWritten}}}}}","variables":{"a":"'$ACC'","d":"'$DAY'","s":"'$DAY'T00:00:00Z","e":"'$(date -u +%Y-%m-%dT%H:%M:00Z)'"}}'
cf -X POST https://api.cloudflare.com/client/v4/graphql -H 'content-type: application/json' -d "$Q" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print("  USAGE: unavailable (bad response: %s)" % e); sys.exit()
if d.get("errors") or not (d.get("data") or {}).get("viewer"):
  print("  USAGE: unavailable (%s)" % "; ".join(e.get("message","?") for e in d.get("errors") or [{"message":"no data"}])[:300]); print("  CHECK usage_under_50pct: FAIL (unverifiable)"); sys.exit()
a=d["data"]["viewer"]["accounts"][0]
S=lambda k,f: sum((g["sum"].get(f) or 0) for g in a.get(k) or [])
rows=[("Workers requests",S("w","requests"),100000),("DO requests",S("o","requests"),100000),
      ("DO duration GB-s",round(S("p","activeTime")/1e6*0.128,1),13000),
      ("D1 rows read",S("q","rowsRead"),5000000),("D1 rows written",S("q","rowsWritten"),100000)]
ok=True
for n,v,l in rows:
  p=100*v/l; ok&=p<50; tag="OK" if p<50 else ("OVER 80%: ROLLBACK ONLY" if p>=80 else "OVER 50% BUDGET")
  print(f"  {n:<18} {v:>12,} / {l:>10,}  {p:5.1f}%  {tag}")
print("  CHECK usage_under_50pct:", "PASS" if ok else "FAIL")'
}
jobs_and_keys(){
echo; echo "== Own background jobs (wrangler/esbuild/workerd/node under /workspace)"
J=$(ps -eo pid,lstart,etime,cmd | grep -E 'wrangler|esbuild|workerd|klickymart|km-verify|nostr-market|mock-servers|lnurlp' | grep -vE 'grep|km-status' | cut -c1-180)
if [ -n "$J" ]; then echo "$J" | sed 's/^/  /'; else echo "  (none)"; fi
echo; echo "== Key files under /workspace (paths only, never contents)"
K=$(find /workspace -xdev \( -name node_modules -o -name '.venv*' -o -name site-packages -o -name _archive \) -prune -o -type f \( -name '*.nsec' -o -name '*.token' -o -name '*ed25519*' -o -name '*.pem' \) -print 2>/dev/null)
if [ -n "$K" ]; then echo "$K" | sed 's/^/  /'; echo "  CHECK no_keys_under_workspace: FAIL ($(echo "$K" | wc -l) file(s))"; else echo "  CHECK no_keys_under_workspace: PASS"; fi
}
{ main; jobs_and_keys; } 2>&1 | scrub
