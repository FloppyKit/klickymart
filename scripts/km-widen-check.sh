#!/usr/bin/env bash
# M4 S1 widen gate: run BEFORE extending the crawl to more sites. Exit 0 = all checks pass.
# Usage: scripts/km-widen-check.sh DOMAINS PRECRAWL_JSONL PLAN_JSONL [LAST_RUN_JSON]
# Runs km-status.sh once (read-only) for CI + usage, unless KM_STATUS_FILE names a saved copy. No network crawling.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -ge 3 ] || { echo "usage: $0 DOMAINS PRECRAWL_JSONL PLAN_JSONL [LAST_RUN_JSON]" >&2; exit 2; }
st="${KM_STATUS_FILE:-}"
if [ -z "$st" ]; then st="$(mktemp /tmp/km-widen-status.XXXXXX)"; trap 'rm -f "$st"' EXIT; timeout 120 "$here/scripts/km-status.sh" > "$st" 2>&1 || true; fi
args=(--domains "$1" --precrawl "$2" --plan "$3" --status "$st"); [ $# -ge 4 ] && args+=(--last-run "$4")
exec timeout 120 python3 "$here/crawler/widen_gate.py" "${args[@]}"
