# Deploy notes: zap@klickymart.com (t92u) and tipping

Do not deploy until Klicky Audit signs off. Production values are public Lightning addresses, not secrets, and live in
`wrangler.toml` under `[env.production.vars]`:

| var | production value | effect |
|---|---|---|
| `LNURL_FORWARD_ZAP` | `DrMattBrown@primal.net` | `GET /.well-known/lnurlp/zap` re-serves `https://primal.net/.well-known/lnurlp/DrMattBrown`; callback is proxied to Primal's callback. Unset = 404. |
| `SITE_TIP_LUD16` | `zap@klickymart.com` | footer value-for-value slot (hidden when unset). |
| `CASHU_MINTS` | unset (uses defaults in tip-rails.ts) | CSP allowlist of mints for in-browser nutzaps. |
| `NWC_RELAYS` | unset (uses defaults) | CSP allowlist of NWC relays. |
| `AUTH_SECRET` | wrangler **secret** (not a var) | login challenge/session HMAC; falls back to `SUBMIT_SALT`. |

Also: apply D1 migration `0016_tip_ready.sql` before deploying.

How zaps behave: the metadata string is Primal's verbatim (`sats for DrMattBrown@primal.net`), so plain payments'
description_hash matches what the payer saw; zaps commit to the 9734 instead. `allowsNostr`/`nostrPubkey` are Primal's,
so 9735 receipts are signed by Primal's zapper key (f81611…8cd3 at check time, 2026-10-30) and verify. KlickyMart never
holds funds: invoices are Primal's.
