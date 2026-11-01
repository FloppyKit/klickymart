# KlickyMart HANDOFF (2026-10-31, environment reset)
**Canonical repo:** `/workspace/klickymart-public` (origin `FloppyKit/klickymart`). Do not build or deploy from
`/workspace/nostr-market` (private research workspace, archived; see below).

## Rails (PLAN.md section 2, Chuck)
- One deploy path: `scripts/km-deploy.sh` (`--check` runs gates only). Refuses: CI not success on the exact HEAD sha,
  dirty tree, HEAD not on origin, crons more often than daily, DO alarm < 24h, new DO binding (unless `--allow-schedule`
  plus `schedule-ok: Matt` in the commit message), any Worker name off the allowlist. Trap deletes test Workers.
  Deploy 5 min cap; one `km-smoke.sh` run (60 s); on failure one `wrangler rollback`, no retry.
- One status path: `scripts/km-status.sh`, pasted verbatim before any done/fixed/deployed/nothing-failed claim.
- Cloudflare: cap 50% of each free-tier daily limit (numbers + source URLs in km-status.sh); over 80% = rollback only.
  No polling ingesters; relay ingest at most daily.
- Timeouts: tests 10 min, deploy 5, smoke 60 s, network 2. No polling loops; check CI once. Jobs > 15 min get an end
  time and kill command. One verification pass per change.
- CI: cancel-in-progress, no pull_request trigger, timeout-minutes 15 e2e / 5 unit; run tests locally before pushing.
- Box only. No paid resources; tips on mocks/regtest only. Clean up own processes, /tmp/km-*, test Workers.
- Logs: `/workspace/km-verify/logs/`, 7-day prune via `scripts/km-prune.sh` (moves to logs/_old, never deletes).

## Matt's decisions (PLAN.md section 6, 2026-10-31 7:55 PM CT)
- Plan applied. No weekly usage cap on the seat (non-budget rails stay).
- Push to FloppyKit/klickymart ONLY after the GO is fully cleared: CI green + verify PASS + dogfood PASS. Missing any => no push.
- Workflow files (`.github/workflows/*`) land through Rule Auditor / the GitHub connector. The box token never gets
  `workflow` scope.
- Keys live at `/home/box/secrets/klickymart/` (700/600), read by path only; never cat/echo/argv. Rule Auditor is
  sweeping the box for plaintext secrets; anything found gets rolled with Matt.

## Open item: Klicky's first GO
`site/worker/src/ingester-do.ts:10` `const ALARM_MS = 30_000;` self-re-arms at `ingester-do.ts:44`
(`finally { ... setAlarm(Date.now() + ALARM_MS) }`) and is first armed at `ingester-do.ts:38`, behind
`LIVE_INGEST=1` (`liveIngestEnabled`, line 23). Remove the loop or make it >= 24 h behind the deploy flag.
`km-deploy.sh` refuses every deploy until this is fixed (schedule gate).

## Other findings from the reset
- Production Worker is `klickymart-production` (`[env.production]` has no `name`); there is no Worker named `klickymart`.
  The deploy/status allowlist is `klickymart klickymart-production`. The shared account also has other non-KlickyMart
  Workers (km-status flags them).
- km-deploy does not yet tag the deployed version with the git sha, so "deployed = HEAD" can't be proven; add
  `--tag <sha>`/`--message` in a follow-up.

## nostr-market
- Diff notes: `/workspace/klicky-seat-plan/nostr-market-diff.md` (unique crawler work, recommended port list).
- Archive: `/workspace/_archive/nostr-market-2026-10-31.tgz` (no secrets/). Port attempt files:
  `/workspace/_archive/port-attempt-2026-10-31/`. Folder rename to `nostr-market.ARCHIVED` waits on the key move.
