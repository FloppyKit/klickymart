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

## Open item: Klicky's first GO
`site/worker/src/ingester-do.ts:10` `const ALARM_MS = 30_000;` self-re-arms at `ingester-do.ts:44`
(`finally { ... setAlarm(Date.now() + ALARM_MS) }`) and is first armed at `ingester-do.ts:38`, behind
`LIVE_INGEST=1` (`liveIngestEnabled`, line 23). Remove the loop or make it >= 24 h behind the deploy flag.
`km-deploy.sh` refuses every deploy until this is fixed (schedule gate).

Also in Klicky's first GO:
- **e2e red:** two debug `page.screenshot` calls in `site/e2e/agent-upgrades.spec.ts` (line 27, full-page `about-dark-desktop-agents.png`, and line 59, `check-blocked-alternatives-dark-desktop.png`) time out at
  90 s after fonts load; the page likely never settles. Fix with `animations: "disabled"` / `reducedMotion: "reduce"`, or
  drop those debug screenshots.
- **Slow smoke:** `site/e2e/smoke.spec.ts` takes ~19.9 min; speed it up or run it in parallel.
- Workflow timeouts are a SEPARATE PR from cloud agent bc-fd2dbd19 into cursor/site-v1-9b41, for Matt to merge (not Klicky).
- **nostr-market crawler port:** hand-merge the 8 diverged files: `crawler/crawl.py`, `crawler/extract.py`,
  `crawler/sign_events.py`, `crawler/tos.py`, `crawler/tests/test_egress_guard.py`, `crawler/tests/test_egress_proxy.py`,
  `crawler/tests/test_extract.py`, `crawler/tests/test_tos.py`; then add the unique modules (list in
  /workspace/klicky-seat-plan/nostr-market-diff.md). The `sites*.json` store lists need Matt's call before they go public.
- **Old key paths in product code** (keys now at /home/box/secrets/klickymart/): `crawler/keygen.py:5`,
  `crawler/sign_events.py:8` (`../secrets/crawler.nsec`), `site/README.md:56` (`nostr-market/secrets/facilitator.nsec`);
  archived nostr-market: `crawler/sign_events.py:17`, `crawler/sign_deletion.py:8`, `crawler/keygen.py:5`,
  `crawler/queue_worker.py:19` (ingest.token). Point them at the new path (env var or fixed path), never argv.

## Other findings from the reset
- Chuck ruling: Worker allowlist = `klickymart-production` + alias `klickymart`; other klickymart* names refused; km-status
  flags only klickymart* Workers. km-deploy tags deploys `--message git:<sha>`; km-status matches that.
- Production Worker is `klickymart-production` (`[env.production]` has no `name`); there is no Worker named `klickymart`.
  The deploy/status allowlist is `klickymart klickymart-production`. The shared account also has other non-KlickyMart
  Workers (km-status flags them).
- The current production deployment predates the git:<sha> tag, so deployed = HEAD stays unprovable until the next km-deploy.

## nostr-market
- Diff notes: `/workspace/klicky-seat-plan/nostr-market-diff.md` (unique crawler work, recommended port list).
- Archive: `/workspace/_archive/nostr-market-2026-10-31.tgz` (no secrets/). Port attempt files:
  `/workspace/_archive/port-attempt-2026-10-31/`. Folder renamed to `/workspace/nostr-market.ARCHIVED` (README inside); keys moved to /home/box/secrets/klickymart/.
