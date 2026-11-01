#!/bin/bash
# km-deploy.sh: the ONE deploy path for KlickyMart (extends /workspace/km-verify/km-deploy.sh, 2026-10-31).
# Clean-archive deploy of klickymart-public HEAD to production; resource IDs injected only into the temp wrangler.toml.
# Gates (chuck.md guardrail 1) run BEFORE any Cloudflare write:
#   - every GitHub Actions run for the exact HEAD sha has conclusion=success (gh CLI; none/pending/red/no-gh => refuse)
#   - clean working tree, HEAD contained in an origin/* branch
#   - crons no more often than daily, no DO alarm interval < 24h, no new DO binding (override: --allow-schedule,
#     which also requires "schedule-ok: Matt" in the HEAD commit message)
#   - Worker name must be on the allowlist (prod env of name "klickymart" => "klickymart-production")
# After deploy: one km-smoke.sh run (60s cap); on failure one `wrangler rollback`, no retry.
# Usage: km-deploy.sh [--check] [--allow-schedule]   (--check runs all gates and exits 0/1 before any Cloudflare write)
set -euo pipefail
REPO=${KM_REPO:-/workspace/klickymart-public}
ALLOWED_WORKERS=${KM_ALLOWED_WORKERS:-"klickymart klickymart-production"}
ALLOWED_DO_BINDINGS=${KM_ALLOWED_DO_BINDINGS:-"INGESTER"}
DAY_MS=86400000
CHECK=0; ALLOW_SCHED=0
for a in "$@"; do case "$a" in --check|--dry-run) CHECK=1;; --allow-schedule) ALLOW_SCHED=1;; *) echo "unknown arg $a"; exit 2;; esac; done
# Log filter: never print tokens, nsec, or 64-hex strings.
scrub(){ grep -iv token | sed -E 's/nsec1[0-9a-z]+/nsec1[REDACTED]/g; s/\b[0-9a-fA-F]{64}\b/[HEX64-REDACTED]/g'; }
refuse(){ echo "REFUSE: $*" | scrub; exit 1; }
cd "$REPO"
SHA=$(git rev-parse HEAD)
echo "km-deploy: repo=$REPO head=$SHA check=$CHECK allow_schedule=$ALLOW_SCHED"

# Test hook: with --check, KM_GATES="tree,ci,schedule,name" limits which gates run (still exits before any write).
GATES=${KM_GATES:-tree,ci,schedule,name}; [ $CHECK = 1 ] || GATES=tree,ci,schedule,name
g(){ [[ ",$GATES," == *",$1,"* ]]; }
# Gate 1: clean tree and HEAD on origin
if g tree; then
[ -z "$(git status --porcelain)" ] || refuse "working tree is dirty"
timeout 120 git fetch -q origin 2>/dev/null || refuse "git fetch origin failed (cannot prove HEAD is on origin)"
[ -n "$(git branch -r --contains "$SHA" 2>/dev/null | grep origin/)" ] || refuse "HEAD $SHA is not on any origin branch"
fi

# Gate 2: CI green on the exact sha
if g ci; then
command -v gh >/dev/null || refuse "gh CLI not installed; cannot verify CI"
timeout 120 gh auth status >/dev/null 2>&1 || refuse "gh not authenticated; cannot verify CI"
SLUG=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')
RUNS=$(timeout 120 gh run list -R "$SLUG" --commit "$SHA" --limit 50 --json status,conclusion,workflowName 2>/dev/null) || refuse "gh run list failed"
python3 - "$RUNS" <<'PY' || refuse "CI not green on $SHA"
import json,sys
r=json.loads(sys.argv[1])
if not r: print("  CI: no runs for this sha"); sys.exit(1)
bad=[x for x in r if x.get("status")!="completed" or x.get("conclusion")!="success"]
for x in r: print(f"  CI: {x['workflowName']}: {x['status']}/{x.get('conclusion')}")
sys.exit(1 if bad else 0)
PY
fi

# Gate 3: schedule (crons, DO alarms, DO bindings)
TOML=site/wrangler.toml
if g schedule; then
sched_bad=()
while read -r c; do
  [ -z "$c" ] && continue
  read -r m h dom mon dow <<<"$c"
  if ! [[ "$m" =~ ^[0-9]+$ && "$h" =~ ^[0-9]+$ ]]; then sched_bad+=("cron '$c' runs more often than daily"); fi
done < <(grep -E '^\s*crons\s*=' "$TOML" | grep -oE '"[^"]+"' | tr -d '"')
while IFS=: read -r f l v; do
  n=$(echo "$v" | grep -oE '[0-9_]+' | head -1 | tr -d _)
  [ -n "$n" ] && [ "$n" -lt $DAY_MS ] && sched_bad+=("DO alarm interval ${n}ms < 24h at $f:$l")
done < <(grep -rnE '(ALARM|INTERVAL)[A-Z_]*_MS\s*=\s*[0-9_]+' site/worker/src 2>/dev/null | sed -E 's/^([^:]+):([0-9]+):.*=\s*([0-9_]+).*/\1:\2:\3/')
while IFS=: read -r f l rest; do sched_bad+=("setAlarm with literal sub-day offset at $f:$l"); done < <(grep -rnE 'setAlarm\(Date\.now\(\) *\+ *[0-9_]{1,8}\)' site/worker/src 2>/dev/null)
for b in $(awk '/durable_objects.bindings/{f=1;next} f&&/^name *=/{gsub(/[" ]/,"",$0);sub("name=","");print;f=0}' "$TOML" | sort -u); do
  [[ " $ALLOWED_DO_BINDINGS " == *" $b "* ]] || sched_bad+=("new DO binding $b")
done
if [ ${#sched_bad[@]} -gt 0 ]; then
  printf '  SCHEDULE: %s\n' "${sched_bad[@]}"
  if [ $ALLOW_SCHED = 1 ]; then git log -1 --format=%B | grep -q 'schedule-ok: Matt' || refuse "--allow-schedule needs 'schedule-ok: Matt' in the HEAD commit message"
  else refuse "schedule gate (${#sched_bad[@]} issue(s)); pass --allow-schedule with Matt's OK recorded"; fi
fi
fi

# Gate 4: Worker name allowlist
if g name; then
BASE=$(grep -m1 -E '^name *=' "$TOML" | cut -d'"' -f2)
PNAME=$(awk '/^\[env.production\]/{f=1;next} /^\[/{f=0} f&&/^name *=/{print}' "$TOML" | cut -d'"' -f2)
WNAME=${PNAME:-$BASE-production}
[[ " $ALLOWED_WORKERS " == *" $WNAME "* ]] || refuse "Worker name '$WNAME' not on allowlist ($ALLOWED_WORKERS)"
fi
echo "  gates PASS ($GATES)"
if [ $CHECK = 1 ]; then echo "CHECK-ONLY: all gates passed; exiting before any Cloudflare write"; exit 0; fi

# ---- Cloudflare writes start here ----
D=/tmp/km-deploy-$(date +%Y%m%d%H%M%S); mkdir "$D"
TEST_WORKERS=()   # any test Worker created must be appended here; trap deletes them
WNAME=${WNAME:-klickymart-production}
cleanup(){ for w in "${TEST_WORKERS[@]:-}"; do [ -n "$w" ] && [ "$w" != "$WNAME" ] && (cd "$REPO/site" && timeout 120 npx wrangler delete --name "$w" --force 2>&1 | scrub); done; rm -rf "$D"; }
trap cleanup EXIT
git -C "$REPO" archive HEAD | tar -x -C "$D"
cd "$D/site"
sed -i 's/database_id = "REPLACE_AT_DEPLOY"/database_id = "449bc56a-16f8-47f6-8a38-3d42060a3cfc"/; s/^id = "REPLACE_AT_DEPLOY"/id = "a613af5d9f944989b3bfd52e169d7267"/' wrangler.toml
! grep -q REPLACE_AT_DEPLOY wrangler.toml
ln -s "$REPO/site/node_modules" node_modules
timeout 300 npx wrangler d1 migrations apply klickymart --remote --env production 2>&1 | scrub | tail -4
timeout 300 npx wrangler deploy --env production 2>&1 | grep -E "Version ID|Uploaded|ERROR|error" | scrub
if timeout 60 bash "$REPO/scripts/km-smoke.sh" > "$D/smoke.out" 2>&1 && ! grep -q '^FAIL' "$D/smoke.out"; then
  scrub < "$D/smoke.out"; echo "SMOKE PASS"
else
  scrub < "$D/smoke.out"; echo "SMOKE FAIL -> one rollback"
  timeout 300 npx wrangler rollback --env production -y 2>&1 | scrub | tail -4
  exit 1
fi
