#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; fi

need() {
  if [[ -z "${!1:-}" ]]; then echo "Missing env $1" >&2; exit 1; fi
}

need CLOUDFLARE_API_TOKEN
need CLOUDFLARE_ACCOUNT_ID

RECORDS="${RECORDS:-$ROOT/fixtures/records.sample.ndjson}"

run() {
  if [[ "$DRY" == 1 ]]; then echo "[dry-run] $*"; else eval "$@"; fi
}

run "wrangler d1 create klickymart || true"
run "wrangler kv namespace create KV || true"
run "wrangler d1 migrations apply klickymart --remote"
run "npm run ingest -- --file $RECORDS --remote"
run "wrangler deploy"
