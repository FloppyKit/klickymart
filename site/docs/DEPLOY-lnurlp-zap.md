# Deploy notes: zap@klickymart.com (t92u) and tipping

Do not deploy until Klicky Audit signs off. Production values are public Lightning addresses, not secrets, and live in
`wrangler.toml` under `[env.production.vars]`:

| var | production value | effect |
|---|---|---|
| `LNURL_FORWARD_ZAP` | `majorbadger18@primal.net` | `GET /.well-known/lnurlp/zap` re-serves `https://primal.net/.well-known/lnurlp/majorbadger18`; callback is proxied to Primal's callback. Unset = 404. |
| `SITE_ZAP_PUBKEY_HEX` | `8a9cdf5624acbed82094d5954137d7febc8f1c41f9cad1ce665bdf40236fd8e4` | KlickyMart's own Nostr account, `npub132wd743y4jldsgy56k25zd7hl67g78zpl89drnnxt005qgm0mrjqfz25ah` (public key). NIP-57 zap requests sent to zap@klickymart.com must have exactly one `p` tag equal to this key (R9-001); zaps for any other recipient get 403. Unset = all zap requests refused and `allowsNostr` not advertised; plain LNURL pay still works. |
| `SITE_TIP_LUD16` | `zap@klickymart.com` | footer value-for-value slot (hidden when unset). |
| `CASHU_MINTS` | unset (uses defaults in tip-rails.ts) | CSP allowlist of mints for in-browser nutzaps. |
| `NWC_RELAYS` | unset (uses defaults) | CSP allowlist of NWC relays. |
| `SUBMIT_SALT` | wrangler **secret**, **REQUIRED** in production (`wrangler secret put SUBMIT_SALT --env production`, 32+ random bytes) | keys the per-network rate-limit hashes. Without it every caller would share one bucket, so with `ENVIRONMENT = "production"` the Worker refuses (503) submissions, `/facilitate`, `/feed/list-check`, `/tip-ready.json`, `/tip/invoice` and zap@ until it is set (R12-005). |
| `AUTH_SECRET` | wrangler **secret** (not a var) | login challenge/session HMAC; falls back to `SUBMIT_SALT`. |

Before deploying: confirm `wrangler secret list --env production` shows `SUBMIT_SALT`. Also: apply D1 migration `0016_tip_ready.sql` before deploying.

How zaps behave: the metadata string is Primal's verbatim (`sats for majorbadger18@primal.net`), so plain payments'
description_hash matches what the payer saw; zaps commit to the 9734 instead. `allowsNostr`/`nostrPubkey` are Primal's,
so 9735 receipts are signed by Primal's zapper key (f81611…8cd3 at check time, 2026-10-30) and verify. KlickyMart never
holds funds: invoices are Primal's.

## Invoice checks (2026-10-31 plain-payment fix)

Primal signs invoices whose `description_hash` commits to neither the metadata it publishes nor the forwarded 9734.
We checked live on 2026-10-31: a plain 1000 msat invoice and a zap invoice both carried `f5e3ee15…`, while
sha256(metadata) is `3e06c683…` and sha256(9734) differs on every request. Wallets accept this for Primal's own
`majorbadger18@primal.net`. Before this fix, zap@ refused every upstream invoice, so plain tips failed.

zap@ now requires, for plain payments and zaps alike:
- the bolt11 decodes and its node signature verifies;
- its amount equals the requested msat;
- it is not expired (at least 30 s left);
- it is mainnet (`lnbc`, not `lntb`/`lnbcrt`/`lnsb`).

`description_hash` is no longer required.

Unchanged: the upstream host pin (the callback must be on the upstream host), the https-only guarded fetch with
DNS checks before and after, no redirects, size caps, rate limits with refunds, and all 9734 validation (p must be
KlickyMart's key, e/a/relays/amount checks).

Trade-off: we can no longer prove that the upstream bound the invoice to what the payer saw (metadata) or to the
zap request. A compromised or misbehaving upstream could return a correctly priced invoice for a different purpose,
and a NIP-57 receipt can't be cross-checked against the invoice hash. The host pin, the amount and the fact that
KlickyMart holds no funds limit the damage to "the payer paid the configured upstream the amount they chose".
If Primal starts committing to the 9734, re-enable the hash check for zaps.

## GP-1 / GP-3 (2026-10-31)

Added on top of the checks above:
- payee node = the key recovered from the invoice signature (must equal the `n` tag when present). If the secret/var
  `ZAP_PAYEE_NODE_PUBKEY` (33-byte compressed hex) is set, the payee must equal it or zap@ returns 502. If it is unset,
  zap@ logs a warning and returns the invoice marked unverified (`klickymart_check.verified=false`,
  `unverified: ["payee_node_not_pinned"]`, header `X-KlickyMart-Invoice-Check`). It does not refuse, so tips keep working until the pin is set.
- replay guard: each payment_hash is stored once in D1 `rate_limits` (`lnf:ph:<hash>`, 24h TTL); a reused hash is a 502.
- description_hash: compared with sha256(9734 as forwarded) for zaps, sha256(upstream metadata) for plain payments.
  A mismatch or missing hash marks the response unverified (Primal does not commit today). Set
  `ZAP_REQUIRE_DESCRIPTION_HASH="1"` to refuse instead.
- failure budget: every failed upstream call (meta or callback) spends a non-refundable unit: 20 per network per
  hour (IPv4 /24, IPv6 /48) and 300 per hour globally. Once spent, zap@ returns 429 without calling upstream.
