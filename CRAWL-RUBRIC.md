# Crawl rubric and record schema

> **v0.3-DRAFT (2026-10-29), not frozen.** Changes since v0.2 are in the section "v0.3 draft changes" at the end. Records produced by crawler v0.2 code after 2026-10-29 carry `"v":"0.3-draft"`.

Machine-first. One record per domain, small, fixed vocabulary, easy to filter.

## Crawler rules

- Stop before payment. Never submit payment details or place an order. Use a test cart only to reach the payment-method screen.
- Respect robots.txt: record what it says; if it disallows the checkout path, record that and do not fetch it (score as blocked for that step).
- A block (captcha, Cloudflare challenge, 403, login wall) is data, not a failure. Record where it occurred.
- Record the date, crawler version and evidence (screenshot hash) for every record.
- Identify the bot with an honest User-Agent and a contact URL.
- Never log in or create accounts. Logged-in-only pages are out of scope; a forced account is recorded as restriction `acct`.
- Read the site's terms; if they ban automated access, the site is not crawled; record `tos` with the quote and URL (see v0.3 draft changes).

## Agent restrictions (`ar`), added after pilot v0.2

We respect every rule, and we publish every restriction. Each entry is `{"c":code,"at":step,"ev":url,"n":short note}`.

| code | meaning |
|---|---|
| `rb_ai` | robots.txt disallows named AI/agent user agents (GPTBot, ClaudeBot, ChatGPT-User, Grok, ...) |
| `rb_ck` | robots.txt disallows cart/checkout for all agents (common Shopify default; informational) |
| `cf` | Cloudflare challenge ("Just a moment...") |
| `ak` | Akamai "Access Denied" |
| `px` | PerimeterX/HUMAN bot script present (challenge not necessarily triggered) |
| `cap` | captcha script/flag present; `cap!` = captcha actually served |
| `403` | plain 403 on a public page |
| `tarpit` | redirect loop, stalled connection or timeout to non-browser clients |
| `hl` | headless browser blocked where plain HTTP was not (needs Playwright run) |
| `js` | content needed for the record only renders client-side |
| `tos` | terms ban automated access (quote + URL in `n`) |
| `acct` | account required to see prices, payment options or to check out |
| `geo` | region block |

`at` steps: `robots`, `land`, `pdp`, `cart`, `help`, `chk`.

## Fields

| field | type | values |
|---|---|---|
| `d` | domain | `example-store.com` (record key) |
| `cat` | codes | from SITE-LIST categories, e.g. `gen`, `elec`, `groc`, `appr`, `home`, `beau`, `food`, `trav`, `tix`, `auto`, `pet`, `toy`, `book`, `sw`, `mkt` (marketplace) |
| `category` | list | coarse shopper-facing category (draft, GO 5.6), one or more of `electronics`, `gift-cards`, `groceries`, `apparel`, `hardware`, `books`, `travel`, `crypto-hardware`, `other`. Derived from `cat` plus domain knowledge for marketplaces; tag `["l","category:<value>","nip-xx"]` once signed |
| `ag` | 0–3 | agent access: 0 blocked at landing, 1 browse only (or key pages blocked), 2 product/cart pages readable, 3 payment-method screen reached and read |
| `ar` | list | agent restrictions with evidence (replaces v0.1 `blk`/`blk_at`, see below) |
| `fetch` | map | HTTP outcome per step, e.g. `{"robots":200,"home":403}` |
| `pay_src` | code | where `pay` came from: `observed-checkout`, `first-party-pages`, `search-index` |
| `pay_tc` | codes | methods mentioned but not verified from a first-party page (TO-CONFIRM) |
| `pay_no` | codes | methods the site says it does NOT accept |
| `kyc` | code | buyer identity: `none-stated`, `conditional` (limits/flags), `required`, null unknown |
| `btc_any` | bool | some bitcoin option exists even if `btc` grade is null |
| `btc_conf` | low/med/high | confidence in the btc grade |
| `tos` | code | `ok`, `bans-automation`, `TO-CONFIRM` |
| `evu` | urls | evidence URLs for payment claims |
| `co` | 0–3 / null | checkout ease: 3 guest ≤3 steps, 2 guest >3 steps, 1 account required, 0 not reachable; null if not observed (pilot: never observed directly, because the crawler stops at robots-disallowed cart/checkout) |
| `steps` | int | page transitions cart→payment screen (null if unreached) |
| `guest` | bool | guest checkout offered |
| `pay` | codes | every method seen (below) |
| `btc` | 0–4 / null | bitcoin grade (below); null when bitcoin is accepted but processor/custody is unverified, or the site was unreadable |
| `proc` | codes | identified payment processors, e.g. `stripe`, `adyen`, `braintree`, `bitpay`, `coinbase`, `btcpay`, `opennode`, `strike`, `square` |
| `ts` | unix | crawl time |
| `v` | str | rubric version |
| `ev` | sha256 | evidence bundle hash |

### Payment codes (`pay`)

Fiat/cards: `card` (Visa/MC/Amex/Disc), `apay` Apple Pay, `gpay` Google Pay, `spay` Shop Pay, `pp` PayPal, `venmo`, `cashapp` (fiat), `zelle`, `ach`, `check`, `cod`, `gift` gift/store card, `bnpl` (Affirm/Klarna/Afterpay; list in `bnpl:<name>` if needed), `ebt`.
Bitcoin: `btc` on-chain, `ln` Lightning, `lnurl`, `bolt12`, `sp` silent payments, `ark`, `cashu`, `fedi` Fedimint, `liq` Liquid.
Other crypto: `usdc`, `usdt`, `eth`, `xmr`, `ltc`, `crypto` (unspecified "pay with crypto").
Unknown: `oth:<label>`.

### Bitcoin grade (`btc`), the sunshine score

| grade | meaning |
|---|---|
| 0 | no bitcoin option |
| 1 | bitcoin only via a third party converting to fiat / custodial KYC processor (e.g. via a card network crypto card, or "crypto" via an exchange account required) |
| 2 | bitcoin or Lightning via a custodial processor that requires no buyer account (merchant-side KYC only) |
| 3 | Lightning or on-chain with no buyer account, via self-hosted processor (BTCPay) or merchant's own node |
| 4 | grade 3 plus privacy features: Lightning without account, ecash, silent payments or Ark; no buyer identity required beyond shipping |

Determining "self-hosted" is a judgment from the invoice page (BTCPay domain under the merchant's control vs. a processor domain). Mark `btc_conf: low` if uncertain.

## Compact record

Pipe-free, short keys, stored as JSON with fixed key order:

```json
{"d":"example-store.com","cat":["elec"],"ag":3,"ar":[{"c":"cap","at":"land","ev":"https://example-store.com/","n":"reCAPTCHA script present"}],"co":3,"steps":3,"guest":true,
 "pay":["card","apay","pp","ln","btc"],"btc":3,"proc":["stripe","btcpay"],"ts":1793232000,"v":"0.1","ev":"<sha256>"}
```

(Illustrative, not a real crawl result.)

## Publication as Nostr events

Each record is an addressable event, kind `31420` (proposed; no collision found in the NIP README or PR/issue search on 2026-10-29, TO-CONFIRM against open PR diffs), signed by the crawler's key, keyed by domain via `d`. Re-crawls replace the prior record. Filterable fields are duplicated as single-letter tags so relays can index them (NIP-01 only indexes single-letter tags).

```json
{
  "kind": 31420,
  "pubkey": "<crawler pubkey>",
  "content": "{\"d\":\"example-store.com\",...full compact record...}",
  "tags": [
    ["d", "example-store.com"],
    ["r", "example-store.com"],
    ["t", "elec"],
    ["l", "ag3", "nip-xx/crawl"], ["l", "co3", "nip-xx/crawl"], ["l", "btc3", "nip-xx/crawl"],
    ["l", "pay:ln", "nip-xx/crawl"], ["l", "pay:btc", "nip-xx/crawl"], ["l", "pay:card", "nip-xx/crawl"],
    ["L", "nip-xx/crawl"],
    ["v", "0.1"]
  ]
}
```

Agent query example (relay-side): `{"kinds":[31420],"#l":["pay:ln"],"#t":["elec"]}`. Intersections beyond one tag value per key are done by the index below.

These records are reviews *about* a domain, signed by the crawler. They are not statements by the business. A business with a NIP-05 claim may publish its own self-description; clients show both.

## Fast index

- Ingest kind 31420 from our relay into D1 (SQLite): one row per domain, columns as fields, a bitmask column per code family (`pay_mask`, `blk_mask`) so filters are integer `AND`s.
- Serve `GET /q?pay=ln&cat=elec&ag>=2&btc>=3` from a Worker with KV cache; response is the compact JSON array, target <50 ms p50 at the edge (target, not measured).
- Optional: embed a one-line summary per record for semantic search (Vectorize), but the primary path is structured filters.
- Export the full set as a single NDJSON file (~200 records, a few tens of KB) so agents can download and filter locally.

## Pilot lessons (v0.1 → v0.2)

- `blk` was too thin: one restriction list with evidence per entry replaces `blk`/`blk_at`, and robots rules targeting AI agents are separated from generic cart disallows.
- `co` and `steps` could not be measured on any site without either a robots-disallowed path or JS. They are now nullable; measuring them needs a Playwright run on robots-allowed paths only.
- Payment lists on big retailers live on help pages, often JS-rendered or 403. Hence `pay_src` and `pay_tc`. Keyword grep of raw HTML gave false positives (e.g. "check" in "checkout", "lightning" in CSS class names, "crypto" from `window.crypto`), so payment extraction must use rendered text of a payment-specific page.
- The btc grade needs the processor; most BTC merchants don't state it. Hence null + `btc_any` + `btc_conf`.
- Negative statements matter (e.g. a store stating "On-chain payments only"), hence `pay_no`.

## v0.3 draft changes (DRAFT, pending Matt / GO 1.2)

### Online vs in-store scope
Every quote in `pay_q` now carries a `scope`:

| scope | meaning |
|---|---|
| `online` | the quoted sentence or its section heading says online / website / app |
| `in-store` | the quoted sentence or its section heading says in store(s), at the register, contactless, authorized stores, etc. |
| `both` | the sentence names both |
| `null` | not stated. Never guessed, even for online-only shops |

Each `pay_q` item: `{"c":code,"neg":bool,"url":evidence URL,"q":exact quote,"conf":"low|med","scope":...}`.

New record fields, derived from `pay_q` (non-negated items):

| field | meaning |
|---|---|
| `pay_online` | methods with an `online` or `both` quote |
| `pay_instore` | methods with an `in-store` or `both` quote |
| `pay_unscoped` | methods seen in a quote with no stated scope and not confirmed online (may also appear in `pay_instore`) |

`pay` stays as the union for compatibility. Agents that want to pay online should filter on `pay_online`, and fall back to `pay_unscoped` only with lower confidence. Negation is now per sentence ("SNAP EBT is accepted online. Cash EBT is not accepted." gives one positive and one negative quote).

### Customer content is never evidence
Customer reviews, Q&A, comments and testimonials are excluded from extraction: DOM blocks matching review/comment/Q&A markup are wrapped in `[ugc-start]`/`[ugc-end]` before text is read, lines under a review or Q&A heading are skipped, and review-shaped lines (star ratings, "Verified Purchase", "N reviews", first-person text on non-payment pages) are skipped.

### Terms of service
`tos`: `ok` (terms page read, no automation clause matched), `bans-automation`, or `null` (unknown). `TO-CONFIRM` is no longer used for this field. Matt's decision (2026-10-29): a site whose terms ban automated access is **not crawled at all**. Its record has `"status":"blocked-tos"`, `tos_q` (exact quote), `tos_url`, an `ar` entry `{"c":"tos","at":"tos",...}`, and every other field null or empty. Tool: `crawler/tos.py` -> `out/tos.jsonl`.

### User agent
`FloppyKitMapBot/0.2 (+https://klickymart.com/bot)`.

### Vantage
`vantage`: where the crawl ran from, e.g. `{"ip":"single-datacenter","n":"..."}`. All v0.3-draft records come from one cloud/datacenter IP; blocks may partly reflect IP reputation. Blocks are recorded as findings, never evaded (no proxies, no rotation).
