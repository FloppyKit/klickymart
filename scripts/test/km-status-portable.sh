#!/bin/bash
# km-status-portable.sh: km-status.sh must work wherever the checkout lives (no /workspace default).
# Makes a throwaway shallow clone, puts gh/wrangler/npx stubs on PATH (canned JSON, no network),
# runs km-status.sh with KM_REPO unset, and asserts the header reports the clone path and that the
# script got past `cd "$REPO"`. Copies nothing secret: only git-tracked files land in the clone.
set -uo pipefail
SRC=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d) || exit 1
trap 'rm -rf "$TMP"' EXIT
CLONE=$TMP/clone
git clone -q --depth 1 "file://$SRC" "$CLONE" || { echo "FAIL: could not clone $SRC"; exit 1; }
BIN=$TMP/bin; mkdir -p "$BIN"

# gh stub: auth ok; run list prints canned JSON (never touches the network).
cat > "$BIN/gh" <<'EOF'
#!/bin/bash
case "$*" in
  "auth status") exit 0;;
  *"run list"*)
    if [[ "$*" == *"--commit"* ]]; then
      echo '[{"workflowName":"site","status":"completed","conclusion":"success"}]'
    else
      echo '[{"headSha":"0123456789abcdef0123456789abcdef01234567","workflowName":"site","status":"completed","conclusion":"success","createdAt":"2026-11-01T12:00:00Z","headBranch":"main"}]'
    fi;;
  *) exit 0;;
esac
EOF

# wrangler stub: canned whoami/deployments/versions output.
cat > "$BIN/wrangler" <<'EOF'
#!/bin/bash
case "$*" in
  *whoami*) echo "You are logged in with an API Token. Account ID: 0123456789abcdef0123456789abcdef";;
  *"deployments list"*--json*) echo '[{"annotations":{"workers/message":"git:0123456"},"versions":[{"version_id":"11111111-1111-1111-1111-111111111111"}],"created_on":"2026-11-01T12:00:00Z"}]';;
  *"deployments list"*) echo "Created: 2026-11-01";;
  *"versions list"*--json*) echo '[{"annotations":{"workers/tag":"v1","workers/message":"git:0123456"},"metadata":{"source":"wrangler"}}]';;
  *) echo "{}";;
esac
EOF

# npx stub: run the named binary from PATH (keeps the test offline; no registry install).
cat > "$BIN/npx" <<'EOF'
#!/bin/bash
exec "$@"
EOF
chmod +x "$BIN/gh" "$BIN/wrangler" "$BIN/npx"

OUT=$TMP/out.txt
( cd "$CLONE" && env -u KM_REPO -u CLOUDFLARE_API_TOKEN -u KM_ALLOWED_WORKERS \
    PATH="$BIN:$PATH" timeout 120 bash "$CLONE/scripts/km-status.sh" ) > "$OUT" 2>&1
RC=$?

fail=0
grep -qF "repo=$CLONE " "$OUT" || { echo "FAIL: header repo= is not the clone path"; grep -m1 '^repo=' "$OUT"; fail=1; }
grep -qE '^repo=.* branch=.* HEAD=' "$OUT" || { echo "FAIL: header incomplete (script exited at cd?)"; fail=1; }
grep -qF "== Key files under " "$OUT" || { echo "FAIL: key-file scan section missing"; fail=1; }
grep -qF "$CLONE" <(grep -m1 '^== Key files under ' "$OUT") || { echo "FAIL: key-file scan does not label the clone root"; fail=1; }
grep -q "CHECK no_keys_under_workspace:" "$OUT" || { echo "FAIL: key-file scan did not run"; fail=1; }
[ "$RC" -eq 0 ] || { echo "FAIL: km-status exited $RC"; fail=1; }

if [ "$fail" -eq 0 ]; then echo "PASS: km-status-portable (repo=$CLONE)"; fi
exit "$fail"
