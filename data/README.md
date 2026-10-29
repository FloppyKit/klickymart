# KlickyMart data: first full crawl

Crawl of 250 commerce sites on 2026-10-29 (16:27–18:49 UTC), with a re-crawl of errored sites and a guest-checkout pass on bitcoin candidates the same day.

| file | contents |
|---|---|
| `sites.json` | the 250-site list: `name` (as the site names itself, null if unclear), `url`, `d` (canonical domain), `cat` (category codes) |
| `records.ndjson` | one JSON record per site (schema: `CRAWL-RUBRIC.md`, version in `v`). Status is `crawled`, `agents-not-welcome` (affirmative refusal: robots disallow, 403, 429, block page), `blocked-tos` (terms ban automation; not crawled) or `error` (network/timeout; no signal). Every payment method carries a quote and URL in `pay_q`. |
| `events.ndjson` | the same 250 records as signed Nostr events, kind `31420` (addressable, `d` = domain), content = the record. Tags are specified in `../NIP-DRAFT.md` (kind 31420 section). |
| `QA-REPORT.md` | totals by status, agent access, payment methods, bitcoin grades with evidence, checkout probe results, agent-hostile findings. |

- **License:** CC0-1.0 (public domain dedication), see `../DATA-LICENSE`. Every event carries `["license","CC0-1.0"]`.
- **Signer:** crawler pubkey `3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242`.
- **Not published.** The events are signed but have not been sent to any relay yet. Kind numbers are provisional (NIP-XX draft).
- **Vantage:** all requests came from one cloud/datacenter IP with an honest user agent (`FloppyKitMapBot/0.2 (+https://klickymart.com/bot)`), no proxies, no captcha solving. Blocks may partly reflect IP reputation, not only site policy.
- **Bitcoin grades** (0–4, see `CRAWL-RUBRIC.md`) are set only with a quote and URL (`btc_src: agent-evidence`); otherwise `btc` is null with `btc_grade_reason` and a possible range. Most bitcoin-positive sites still need hand grading.
- **Checkout probe:** guest checkout up to the payment-method screen only; no order was placed and no account created.
