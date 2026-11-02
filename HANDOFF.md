# KlickyMart HANDOFF (2026-10-31, environment reset)
**Canonical repo:** `/workspace/klickymart-public` (origin `FloppyKit/klickymart`). Do not build or deploy from
`/workspace/nostr-market.ARCHIVED` (private research workspace, archived; see below).

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

## Status (re-checked 2026-11-01 ~9:00 PM CT)
Klicky's first GO is done. `main` 016e596 was deployed through `km-deploy.sh` at 6:58 PM CT as `klickymart-production`
version fe74e814 (message `git:016e596`); `km-status.sh` passes every check (CI green on HEAD, deployed = HEAD,
only cron `15 6 * * *`, one Worker, usage < 1%). Resolved:
- DO alarm loop: `ALARM_MS` is gone. `LIVE_INGEST` is only an off switch (`site/worker/src/ingester-do.ts:23-25,44,48`):
  off (the default, not set in `site/wrangler.toml`) = shut down, drop the alarm, no re-arm.
- e2e: debug screenshots in `site/e2e/agent-upgrades.spec.ts` now use `animations: "disabled"`; CI `site` is green.
- Smoke: the whole `site` CI job took ~6 min on 016e596 (run 41369436057), down from ~19.9 min for smoke alone.
- Old key paths: `crawler/keygen.py:5` reads `KM_CRAWLER_NSEC` (default `/home/box/secrets/klickymart/crawler.nsec`);
  `site/README.md:56` names `/home/box/secrets/klickymart/facilitator.nsec`.

Still open:
- **nostr-market crawler port:** 7 of the 8 files still differ from `/workspace/nostr-market.ARCHIVED/crawler/`
  (`crawl.py`, `extract.py`, `sign_events.py`, `tests/test_egress_guard.py`, `tests/test_egress_proxy.py`,
  `tests/test_extract.py`, `tests/test_tos.py`); `tos.py` is identical. Unique modules: see
  /workspace/klicky-seat-plan/nostr-market-diff.md. The `sites*.json` store lists need Matt's call before they go public.

## Other findings from the reset
- Chuck ruling: Worker allowlist = `klickymart-production` + alias `klickymart`; other klickymart* names refused; km-status
  flags only klickymart* Workers. km-deploy tags deploys `--message git:<sha>`; km-status matches that.
- Production Worker is `klickymart-production` (`[env.production]` has no `name`); there is no Worker named `klickymart`.
  The deploy/status allowlist is `klickymart klickymart-production`. The shared account also has other non-KlickyMart
  Workers (km-status flags them).
- Deploys carry `git:<sha>` (first one: 016e596 on 2026-11-01), so km-status proves deployed = HEAD.

## nostr-market
- Diff notes: `/workspace/klicky-seat-plan/nostr-market-diff.md` (unique crawler work, recommended port list).
- Archive: `/workspace/_archive/nostr-market-2026-10-31.tgz` (no secrets/). Port attempt files:
  `/workspace/_archive/port-attempt-2026-10-31/`. Folder renamed to `/workspace/nostr-market.ARCHIVED` (README inside); keys moved to /home/box/secrets/klickymart/.
