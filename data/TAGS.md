# Kind 31420 tag vocabulary

Generated from the crawler's constants. Kinds (provisional): site record `31420`, need `420`, fulfillment `421`, acceptance `422`. `l` tags are NIP-32 labels `["l","<key>:<value>","nip-xx"]`. Unknown values are omitted, never placeholders. Full spec: `../NIP-DRAFT.md`.

| key | allowed values | meaning |
|---|---|---|
| `d` | canonical domain | site identity; newest event per pubkey+d wins |
| `r` | same domain | generic domain lookup |
| `L` | `nip-xx` | label namespace |
| `t` | `shopping` + subcategory codes (open) | category |
| `l category:` (draft, not yet in signed events) | `electronics`, `gift-cards`, `groceries`, `apparel`, `hardware`, `books`, `travel`, `crypto-hardware`, `other` | coarse category for alternatives lookup; site uses `data/category-map.json` until records are re-signed |
| `l status:` | `agents-not-welcome`, `blocked-tos`, `crawled`, `error` | crawl outcome |
| `l tos:` | `bans-automation`, `ok`, `unknown` | terms of service on automation |
| `l pay:` | `ach`, `apple-pay`, `ark`, `bnpl`, `bolt12`, `btc-onchain`, `card`, `cashapp`, `cashu`, `check`, `cod`, `crypto`, `ebt`, `ethereum`, `fedimint`, `gift-card`, `google-pay`, `hsa-fsa`, `lightning`, `liquid`, `litecoin`, `lnurl`, `monero`, `paypal`, `shop-pay`, `silent-payments`, `usdc`, `usdt`, `venmo`, `zelle`, `bnpl:<provider>`, `other:<label>` | payment method seen, any scope |
| `l pay_online:` / `l pay_instore:` / `l pay_unscoped:` | same values as `pay:` | method by scope |
| `l no:` | same values as `pay:` | method the site says it does not accept |
| `l btc:` | `0`–`4` | bitcoin grade (CRAWL-RUBRIC.md); omitted when ungraded |
| `l btc_any` | (no value) | some bitcoin payment evidence quoted |
| `l btcpriv:` | `ark`, `ecash`, `noacct`, `nokyc`, `selfhosted`, `sp` | bitcoin privacy flags |
| `l ag:` | `0`–`3` | agent reachability |
| `l co:` | `0`–`3` | checkout ease |
| `l guest:` | `yes`, `no` | guest checkout |
| `l kyc:` | `none-stated`, `conditional`, `required` | buyer identity requirement |
| `l ar:` | `rb_ai`, `rb_ck`, `403`, `429`, `cap`, `cf`, `ak`, `px`, `js`, `tarpit`, `net`, `acct`, `tos`, `block` | agent restriction found |
| `l anw:` (status agents-not-welcome) | `block-page`, `http-403`, `http-429`, `http-503`, `robots-403`, `robots-429`, `robots-block-page`, `robots-disallow` | affirmative refusal |
| `l anw:` (status error) | `home-unreachable`, `robots-unreachable` | could not tell; not a refusal |
| `l cause:` | `4xx`, `5xx`, `connect`, `decode`, `dns`, `redirect-loop`, `timeout`, `tls`, `unknown` | failure cause for status error |
| `crawled_at` | unix seconds | observation time |
| `v` | rubric version, e.g. `0.3-draft` | record schema version |
| `license` | `CC0-1.0` | data license |
| `name` | text | site's display name |
| `vantage` | `single-datacenter`, `residential`, `multi-region`, `human` | crawl vantage point |
| `crawler` | product/version, info URL | software that produced the record |
