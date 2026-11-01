# Ledger trust (data/hand-first-seen.jsonl, data/hand-anomalies.jsonl)

Both ledgers are tracked in git and append-only (tests/test_tracked_ledgers.py, crawler/check_append_only.py, CI `ledgers`
job). A first-seen row's effective date is max(written first_seen, commit date of its line); late commits are clamped
and flagged as `late_commit` anomalies. Uncommitted rows don't count. Without git (or with a failed blame) the tracked
ledger fails closed.

## Accepted residual: operator trust line

- Anyone with commit access can backdate a commit (`GIT_COMMITTER_DATE`) or edit rows before they are committed. This is
  accepted until v9.2 operator-key signing of hand grades and clears lands.
- A GitHub push-time floor (server-side receive date) is optional.
- Reopen this if anyone other than Matt gets commit access to the ledger, or if hand overrides grow past a handful
  (2 today: bestbuy.com, sonos.com).
