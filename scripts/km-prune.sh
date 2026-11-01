#!/bin/bash
# km-prune.sh: move km-verify logs older than 7 days into logs/_old (never deletes).
set -euo pipefail
L=${KM_LOGS:-/workspace/km-verify/logs}; mkdir -p "$L/_old"
find "$L" -maxdepth 1 -type f -name '*.log' -mtime +7 -print -exec mv -n {} "$L/_old/" \;
