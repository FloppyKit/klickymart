NIP-XX
======

Commerce Site Directory and Need / Fulfillment / Acceptance Handshake
---------------------------------------------------------------------

`draft` `optional`

This NIP defines one kind family:

| kind    | type        | name             | meaning                                                         |
|---------|-------------|------------------|-----------------------------------------------------------------|
| `31420` | addressable | Site record      | one signed observation of one commerce site, keyed by domain     |
| `420`   | regular     | Need             | "I have a need", with an optional offered payment               |
| `421`   | regular     | Fulfillment      | "I met your need; here is proof", with an optional amount owed |
| `422`   | regular     | Acceptance       | "Yes, you met my need", with payment and/or an optional tip    |

`31420` lets any client or agent find sites it can reach and pay (with special attention to privacy-respecting bitcoin) by filtering on tags alone. `420–422` is a generic handshake for posting a need, claiming it was met, and closing the loop with payment; the directory is one thing it can point at.

**Kind numbers are provisional.** Implementations MUST define each kind number in a single constant (e.g. `KIND_SITE = 31420`) so the numbers can be changed if NIP review asks. See "Numbering and kind checks".

## Why 31420 is addressable and 420–422 are regular

A site record is a current-state observation: a re-crawl of `example.com` supersedes the previous one. As an addressable event (`30000 ≤ kind < 40000`), relays keep only the newest event per `(pubkey, kind, d)`, so re-crawls replace older records without deletions and each publisher has exactly one record per domain. History, if wanted, is kept off-relay by the publisher.

Needs, fulfillments and acceptances are facts in a sequence. Each must stay addressable by `id` so later events can reference it with `e` tags, and a later event must never erase an earlier one (a 422 that replaced its 421 would destroy the proof). They are therefore regular events.

## Kind 31420: Site record

One event per site per publisher. `d` is the canonical domain: lowercase, IDNA/punycode, no scheme, no path, no leading `www.` (e.g. `example.com`, `shop.example.org`). Newest `created_at` replaces older per `pubkey + d`.

`.content` is the canonical JSON record (the full observation, including evidence quotes and URLs), serialized compactly. Its schema is the crawl rubric (`CRAWL-RUBRIC.md`, versioned by `v`). Tags duplicate the filterable fields so a client never needs to parse content to filter. If tags and content disagree, content wins and the event SHOULD be treated as malformed.

### Tag conventions

Relays index only single-letter tags (NIP-01). Filterable facts are therefore NIP-32 labels in one namespace:

```
["L", "nip-xx"]
["l", "<key>:<value>", "nip-xx"]
```

so a filter like `{"kinds":[31420],"#l":["pay:lightning"]}` works on any relay. Category uses `t`. Non-filterable metadata uses multi-letter tags. Unknown `l` keys MUST be ignored, so the vocabulary can grow.

### Required tags

| tag | example | meaning |
|---|---|---|
| `d` | `["d","example.com"]` | canonical domain |
| `r` | `["r","example.com"]` | same domain, for generic `#r` lookups across kinds |
| `L` | `["L","nip-xx"]` | label namespace |
| `t` | `["t","shopping"]` | top-level category (open vocabulary; v1 uses `shopping` = consumer goods; later e.g. `services`, `food`, `travel`) |
| `l status:` | `["l","status:crawled","nip-xx"]` | `crawled`, `blocked-tos` (terms ban automation; not crawled; bare record: name, URL, status, ToS quote, and no other labels), `agents-not-welcome` (site affirmatively refused: robots disallow, 403, 429 or block page), `error` (network/timeout/5xx; could not tell, not counted as a refusal) |
| `l tos:` | `["l","tos:ok","nip-xx"]` | terms of service on automation: `ok` (read, no ban found), `bans-automation`, `unknown` |
| `crawled_at` | `["crawled_at","1793291247"]` | unix time of observation (may differ from `created_at` if signed later) |
| `v` | `["v","0.3-draft"]` | record schema / rubric version |
| `license` | `["license","CC0-1.0"]` | data license of the record (SPDX id) |

### Optional tags

| tag | example | meaning |
|---|---|---|
| `t` (more) | `["t","elec"]` | subcategory codes (`gen`, `elec`, `appr`, `home`, `groc`, `mkt`, `sw`, …; open vocabulary) |
| `name` | `["name","Example Store"]` | display name the site shows for itself |
| `l pay:` | `["l","pay:lightning","nip-xx"]` | payment method observed, any scope (union of the three below). Values: see Payment tag values |
| `l pay_online:` | `["l","pay_online:btc-onchain","nip-xx"]` | method stated for online checkout |
| `l pay_instore:` | `["l","pay_instore:card","nip-xx"]` | method stated for physical stores only |
| `l pay_unscoped:` | `["l","pay_unscoped:paypal","nip-xx"]` | method mentioned without a clear scope |
| `l no:` | `["l","no:btc-onchain","nip-xx"]` | method the site explicitly says it does not accept |
| `l btc:` | `["l","btc:3","nip-xx"]` | bitcoin grade 0–4 (below). Omitted when ungraded |
| `l btc_any` | `["l","btc_any","nip-xx"]` | some bitcoin option was quoted, grade not yet set |
| `l btcpriv:` | `["l","btcpriv:noacct","nip-xx"]` | privacy flags: `noacct` (no buyer account needed), `selfhosted` (merchant's own BTCPay/node), `ecash`, `sp` (silent payments), `ark`, `nokyc` (no buyer identity beyond shipping) |
| `l phonereq:` | `["l","phonereq:yes","nip-xx"]` | guest checkout probe: `yes` = a phone number was required before the payment step, `no` = the probe got past the contact step without one. Omitted when the probe did not reach a checkout form. Content: `checkout_probe.phone_required` |
| `l ag:` | `["l","ag:2","nip-xx"]` | agent reachability 0–3: 0 blocked at landing, 1 browse only, 2 product/cart readable, 3 payment screen reached |
| `l ar:` | `["l","ar:rb_ai","nip-xx"]` | agent restriction found: `rb_ai` (robots disallows AI agents), `rb_ck` (robots disallows cart/checkout), `403`, `429`, `cap` (captcha), `cf`/`ak`/`px` (Cloudflare/Akamai/PerimeterX block), `js`, `tarpit`, `net`, `acct` (forced account), `tos` |
| `l anw:` | `["l","anw:robots-403","nip-xx"]` | why the site was not crawled. With status `agents-not-welcome` (affirmative refusal only): `robots-disallow`, `robots-403`, `robots-429`, `robots-block-page`, `http-403`, `http-429`, `http-503`, `block-page`. With status `error` (no signal either way): `robots-unreachable`, `home-unreachable` |
| `l cause:` | `["l","cause:timeout","nip-xx"]` | with status `error`: `dns`, `timeout`, `tls`, `connect`, `5xx`, `4xx`, `redirect-loop`, `decode`, `unknown` |
| `l co:` | `["l","co:2","nip-xx"]` | checkout ease 0–3 (rubric) |
| `l sub:` | `["l","sub:audio","nip-xx"]` | product family (v0.4), repeatable |
| `l agentpolicy:` | `["l","agentpolicy:restricts-agents","nip-xx"]` | pages reachable but terms/known practice restrict agent orders; quotes in content `agent_policy` |
| `l shippre:` / `l shipsus:` | `["l","shippre:yes","nip-xx"]` | landed cost: shipping+tax shown before payment / ships to US (content `ship`) |
| `l guest:` | `["l","guest:yes","nip-xx"]` | guest checkout `yes` / `no` |
| `l kyc:` | `["l","kyc:none-stated","nip-xx"]` | buyer identity: `none-stated`, `conditional`, `required` |
| `vantage` | `["vantage","single-datacenter"]` | where the crawl ran from (`single-datacenter`, `residential`, `multi-region`, `human`). Blocks may reflect IP reputation; readers SHOULD weigh `ag`/`ar` by vantage |
| `crawler` | `["crawler","FloppyKitMapBot/0.2","https://example.org/bot"]` | software and version that produced the record, optional info URL |
| `e`/`a` | `["a","31420:<pubkey>:example.com"]` | in third-party records: the record being corrected |

Payment tag values (readable; publishers keep any internal codes they like and map them to these): fiat `card`, `apple-pay`, `google-pay`, `shop-pay`, `paypal`, `venmo`, `cashapp`, `zelle`, `ach`, `check`, `cod`, `gift-card`, `ebt`, `hsa-fsa`, `bnpl` or `bnpl:<provider>`; bitcoin `btc-onchain`, `lightning`, `lnurl`, `bolt12`, `silent-payments`, `ark`, `cashu`, `fedimint`, `liquid`; other crypto `usdc`, `usdt`, `ethereum`, `monero`, `litecoin`, `crypto` (unspecified); anything else `other:<label>`.

Bitcoin grade: 0 none; 1 only via a third-party fiat converter or buyer-KYC custodian; 2 via a custodial processor with no buyer account; 3 on-chain or Lightning, no buyer account, self-hosted processor or merchant's own node; 4 grade 3 plus privacy features (ecash, silent payments, Ark) and no buyer identity beyond shipping.

Unknown is expressed by omitting the tag, never by a placeholder value (except `tos:unknown`, which is required).

### Querying

- Sites accepting Lightning: `{"kinds":[31420],"#l":["pay:lightning"]}`
- Grade 3+ bitcoin: `{"kinds":[31420],"#l":["btc:3","btc:4"]}`
- Shopping sites from a trusted publisher: `{"kinds":[31420],"authors":["<pk>"],"#t":["shopping"]}`

NIP-01 filters OR values within one tag key and cannot AND two values of the same key (`pay:lightning` AND `ag:2`); clients intersect locally. Publishers MAY also offer a bulk NDJSON export of all their events.

### Publishers, corrections, trust

Any pubkey may publish 31420 records. Because addressability is per pubkey, a third party's record for `example.com` never overwrites another publisher's; it sits beside it.

- **Corrections.** A human or agent who disagrees publishes their own 31420 for the same `d` and adds `["a","31420:<original-pubkey>:<domain>"]` plus the specific fields they observed, with evidence URLs in content. A narrow correction MAY include only the tags it asserts plus the required ones.
- **Trust is by pubkey.** Clients choose which publishers to read (a follow list, a NIP-51 list of directory publishers, or NIP-85 trusted assertions). There is no global record; when publishers disagree, clients show the disagreement or prefer the newest `crawled_at` from a trusted key.
- **Precedence.** A 31420 from the domain's NIP-05-verified merchant key outranks third-party records and corrections for that domain. For every other publisher, trust is the client's choice; the protocol sets no rate limits on corrections.
- **Merchant claim (NIP-05).** A business claims its domain by serving `https://<domain>/.well-known/nostr.json` with `{"names":{"_":"<hex pubkey>"}}`. A 31420 whose author matches that `_` entry for its `d` is the merchant's self-description; clients SHOULD label it as such and rank it above third-party records (see Precedence), while still letting users see the third-party observations. Merchant records are claims, not verified observations. Clients SHOULD record when they last checked the NIP-05 mapping; if it changes, earlier events stay signed by the old key.
- Publishers MUST NOT create or hold keys on behalf of a business that has not consented.

## Kinds 420 / 421 / 422: Handshake

A loop is the chain `420 → 421 → 422`. Each references the earlier events with `e` tags (markers `need`, `fulfillment`). Any of them MAY reference a directory record with `["a","31420:<pubkey>:<domain>"]` (the record consulted) and the domain with `["r","<domain>"]`.

Layering: higher-level features are tag conventions on top of this loop, not new kinds. Examples: a shopping agent posts a 420 with `["t","shopping"]` and `r`/`a` pointing at a site it found in the directory; a 421 proves purchase with `["proof","order",…]`; a correction bounty is a 420 asking for a fresh 31420 of a domain, met by a 421 with `["proof","event","<31420-id>"]`; reputation indexes count accepted, paid loops.

## Kind 420: Need

`.content` is a human- or machine-readable description of the need (MAY be empty if fully described by tags, MAY be encrypted, see Private needs).

Tags:

- `t` (optional, repeatable): category, e.g. `["t","commerce"]`, `["t","translation"]`.
- `amount` (optional): offered payment `["amount", "<millisats>", "<unit>"]`. `unit` defaults to `msat`; other ISO 4217 codes MAY be used as an indication only, settlement is in bitcoin.
- `payment` (optional, repeatable): accepted settlement methods, e.g. `["payment","zap"]`, `["payment","cashu","<mint-url>"]`, `["payment","bolt11"]`.
- `expiration` (optional): NIP-40 expiration timestamp.
- `p` (optional, repeatable): directed need, addressed to specific pubkeys.
- `r` (optional): a domain or URL the need concerns, e.g. `["r","example.com"]`.
- `relays` (optional): where the requester will look for 421s.
- `k` (optional): kind(s) of result the requester expects (lets 420 wrap NIP-90-style jobs).

```json
{
  "kind": 420,
  "content": "Need 2x USB-C 100W cables delivered to ZIP 60601 by Friday, merchant must accept Lightning.",
  "tags": [
    ["t", "commerce"],
    ["amount", "40000000", "msat"],
    ["payment", "zap"],
    ["payment", "cashu", "https://mint.example"],
    ["expiration", "1793836800"],
    ["relays", "wss://relay.example"]
  ]
}
```

### Store claims its listing (draft)

A store can stand beside the crawler's record for its domain with its own record. Nothing here replaces or removes the crawler record.

1. **Prove the domain.** The store controls a key and proves it controls the domain in one of two ways:
   - NIP-05: `https://<domain>/.well-known/nostr.json` returns `{"names":{"_":"<hex pubkey>"}}`; or
   - DNS: a TXT record at `_nostr.<domain>` with value `nostr=<hex pubkey>` (or `npub1...`).
   Indexers fetch the proof themselves (honest UA, robots.txt does not apply to `/.well-known/nostr.json`, which the store published for this purpose), record `checked_at`, and re-check at least every 30 days. If the proof disappears or points to another key, the claim lapses from that time; earlier events stay signed by the old key.
2. **Publish its own 31420.** The store signs a 31420 with `d` = its domain and the same tag vocabulary (pay methods, checkout facts, shipping and tax policy, agent policy). It MAY add `["a","31420:<crawler-pubkey>:<domain>"]` to point at the record it is answering, and `["claim","nip05"|"dns"]` naming its proof.
3. **Display.** Clients show the store's record **beside** the crawler record, labelled "from the store" (a claim, not an observation), and the crawler record labelled "observed by <crawler>" with its `crawled_at`. Where they disagree, both are shown; neither silently wins. Store-supplied facts MAY rank first in lists, with the observation still visible.
4. **The crawler record is never deleted.** The crawler keeps observing and publishing its own 31420 for the domain. A store cannot request its removal through this mechanism (terms-of-service bans on crawling are handled by the crawler skipping the site, as before).
5. **No custodial keys.** Indexers and crawlers MUST NOT generate, hold or hand over keys for a store. The store creates its own key; the indexer only learns its public key from the domain proof. (There is no "assigned key we give the store later": anything the indexer generated, the indexer could still sign with.)

## Kind 421: Fulfillment

Published by the fulfiller. `.content` is the proof or a description of it.

Tags:

- `e` (required): id of the `420`, with relay hint and marker `["e","<420-id>","<relay>","need"]`.
- `p` (required): pubkey of the requester.
- `amount` (optional): amount owed `["amount","<msat>"]`. If present without an offer in the 420, the requester MAY decline.
- `bolt11` (optional): invoice for the amount owed.
- `proof` (optional, repeatable): `["proof","<type>","<value>"]`, where type is one of `url`, `sha256` (hash of a deliverable), `tracking` (carrier, number), `event` (id of a result event), `order` (merchant order reference). Proof is evidence, not a guarantee; the requester judges it.
- `r` (optional): domain of the merchant / service that fulfilled, when the fulfiller acts for a domain (see Businesses).

## Kind 422: Acceptance

Published by the original requester (MUST be the 420 author; clients MUST ignore 422s from anyone else).

Tags:

- `e` (required): `["e","<421-id>","<relay>","fulfillment"]` and `["e","<420-id>","<relay>","need"]`.
- `p` (required): the fulfiller's pubkey.
- `amount` (optional): amount paid including tip, in msat.
- `tip` (optional): portion of `amount` that is a tip.
- `preimage` (optional): payment preimage for the `bolt11` in the 421.
- `zap` (optional): id of the NIP-57 zap receipt (kind `9735`) that paid the fulfiller.
- `cashu` (optional): proof of ecash payment, see Payments.
- `status` (optional): `accepted` (default) or `rejected`. A rejected 422 closes the loop without payment and does not count toward reputation.

`.content` MAY carry a short note or review.

### Handshake shape rules

- 420 MUST NOT carry `e` tags with marker `need` or `fulfillment`; at most one `amount`.
- 421 MUST carry exactly one `e` with marker `need` and exactly one `p` (the 420 author); at most one `amount`; `proof` types are `url`, `sha256` (64 hex), `tracking`, `event` (64 hex), `order`.
- A 422 that cites a `need` MUST also cite the `fulfillment` and carry exactly one `p` (the 421 author). `tip` requires `amount` and `tip ≤ amount`. `preimage` is 64 hex; `zap` is a kind 9735 event id.
- Validators implement these in `site/worker/src/handshake.ts`; KlickyMart stores the resulting marks at ingest (`handshake_marks`, kill switch `KM_HANDSHAKE_MARKS`), display/audit only.

### Handshake amounts

All amounts are decimal strings of millisatoshis: no sign, no leading zeros, no exponent, at most 21e6 BTC
(2.1e18 msat). A 420 `amount` MAY carry a third element naming an ISO 4217 unit as an indication only; settlement is in bitcoin.

### Handshake validation (marks)

Validators produce **marks**, never scores. An event that fails the shape rules above is `invalid` and SHOULD be ignored.
Thread marks (on otherwise valid events):

| mark | on | condition |
|---|---|---|
| `duplicate` | any | same event id seen again (replay); count once |
| `orphan` | 421/422 | a referenced event is not known |
| `self_fulfillment` | 421 | 421 author == 420 author |
| `requester_mismatch` | 421 | 421 `p` ≠ 420 author |
| `not_directed` | 421 | 420 has `p` tags and 421 author is not among them |
| `owed_exceeds_offer` / `owed_without_offer` | 421 | owed > offer (msat offers only) / owed with no offer; requester MAY decline |
| `acceptor_not_requester` | 422 | 422 author ≠ 420 author — clients MUST ignore |
| `need_mismatch` | 422 | the 422's `need` ≠ the `need` referenced by its 421 |
| `fulfiller_mismatch` | 422 | 422 `p` ≠ 421 author |
| `paid_below_owed` | 422 | accepted and `amount − tip` < 421 owed |
| `payment_claimed_unverified` / `accepted_unpaid` | 422 | accepted with / without a payment field |
| `multiple_acceptances` | 422 | several 422s from the 420 author cite the same 421: still ONE loop, none picked (created_at is self-asserted) |
| `unit_not_comparable` | 421 | owed msat but the 420 offer is in another unit |
| `rejected_with_payment` | 422 | `status=rejected` with amount/preimage/zap/cashu (still valid) |
| `no_proof` | 421 | no `proof` tag and empty content (still valid) |
| `late_fulfilment` | 421 | 421 `created_at` (self-asserted) after the 420's `expiration` (still valid) |

Principle (Satoshi, 2026-11-01): the validator states facts as marks; `invalid` only for broken shape; scorers decide.
Indexers count every **structurally complete loop**. Only a 422 signed by the 420's author closes a loop.

A loop (420→421→422) is reported only when the 422 is `accepted` and has none of `acceptor_not_requester`,
`need_mismatch`, `fulfiller_mismatch`.

### Handshake security considerations

- **Payment proof.** Payment fields are self-reported claims; nothing in this NIP verifies payment. The strongest evidence
  that a need was met is the 420 author's own signed 422. A preimage the payee minted for its own invoice, or a zap receipt signed by the payee's own LNURL
  service, proves nothing about a third party paying. Validators MUST treat these as claims. Upgrading a claim to
  verified requires keys bound to the payee independently of the event author (see NIP-DRAFT.md Reputation / proof tiers)
  and is out of scope here.
- **Sybils.** One operator with many keys can produce structurally perfect loops between its own keys. Only same-key
  self-fulfilment is detectable from the events. Cross-key collusion is a weighting problem for indexers, not a validity rule.
- **Tips** are display only and MUST NOT affect ranking or any mark.
- **Custody.** Indexers MUST NOT hold funds, keys, wallet connections or ecash on behalf of users.

### Kind collision check (CASCADE 1.1, 2026-11-01, read-only)

- nips README kind table (https://github.com/nostr-protocol/nips/blob/master/README.md, fetched from
  https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md): no entry for `420`, `421`, `422`, and no range
  covers them. Nearest neighbours: `443`–`445` (Marmot). `31420` and `1423` also absent.
- Open PRs: `gh search prs --repo nostr-protocol/nips --state open "kind 420"` (also 421, 422) returned none. All 482 open
  PRs listed via `gh pr list --state open`; diffs of 481 grepped for added lines containing `420`/`421`/`422` as a word.
  One hit, https://github.com/nostr-protocol/nips/pull/2073, is a category-ID CSV (rows like `420,417,Phone Services`), not
  event kinds. One PR's diff (2102) came back empty and was not checked.
- Closed PRs with those numbers in the title (https://github.com/nostr-protocol/nips/pull/420, /pull/421, and
  https://github.com/nostr-protocol/nips/pull/375 "NIP-420" supply-chain, closed) are PR/NIP numbers, not kind claims.
- Result: **no collision found** as of 2026-11-01. Kinds remain provisional; re-check before any submission.

### 422 as a merchant review

A kind `422` MAY also be a standalone review of a merchant, with or without a preceding 420/421. A review-422:

- MUST carry `["a","31420:<record-author-pubkey>:<domain>"]` pointing at the merchant's site record, and SHOULD carry `["r","<domain>"]`.
- MUST carry `["rating","<n>","<max>"]` (integers, `0 ≤ n ≤ max`, `max` defaults to `5`, at most `10`).
- MUST carry `["attempt","browse"|"cart"|"checkout"|"paid"]`: how far the reviewer got.
- MAY carry `["pay","<payment code>"]` (31420 `pay` vocabulary, e.g. `lightning`), the method actually used.
- MAY accept a fulfillment: `["e","<421-id>","<relay>","fulfillment"]` plus a payment proof (`zap`, `preimage`, `cashu`) as above. Only then can it count toward reputation, under the rules in Reputation.
- MAY carry NIP-32 labels `["L","nip-xx"]`, `["l","review","nip-xx"]`.
- `.content` is the review text (indexers MAY cap length; KlickyMart caps at 2000 characters).

The "MUST be the 420 author" rule applies only to 422s that reference a `need`. A review-422 with no `need` tag is a signed claim by its author and nothing more. Indexers SHOULD show it as a claim, SHOULD NOT treat it as verified, and SHOULD rate-limit per pubkey. Reviewers who want pseudonymity SHOULD use a keypair dedicated to reviews and never reuse a key tied to an identity. Indexers MUST NOT ask for secret keys and SHOULD accept only signed events.

```json
{
  "kind": 422,
  "pubkey": "<reviewer-pubkey-hex>",
  "created_at": 1793400000,
  "tags": [
    ["a", "31420:<crawler-pubkey-hex>:example.com"], ["r", "example.com"],
    ["rating", "4", "5"], ["attempt", "checkout"], ["pay", "lightning"],
    ["L", "nip-xx"], ["l", "review", "nip-xx"]
  ],
  "content": "Guest checkout reached the payment screen in 3 steps; Lightning offered, no account needed.",
  "id": "<id>", "sig": "<sig>"
}
```

## 422 as a shopping experience

No new kind. A kind 422 note can describe how an agent's shopping attempt at a store went. KlickyMart reads these from public relays (and from `POST /reviews`) and builds the store chart (`/chart`, `/chart.json`) from them. KlickyMart never signs or publishes for anyone; `build_experience_note` (MCP) and `GET /report/template` return an unsigned template.

| Tag | Meaning |
|---|---|
| `["a","31420:<pk>:<domain>"]` / `["r","<domain>"]` | the store (one required) |
| `["product","<url>"]` or `["gtin","<gtin>"]` | product (optional) |
| `["basis","visit|directory|secondhand"]` | visit = the agent went to the store; directory = written from KlickyMart data; secondhand = relayed from someone else. Missing = visit (with a warning). Only `visit` notes count toward aggregates and corroboration |
| `["depth","browse|product|cart|checkout|shipping|payment|paid|delivered"]` | furthest stage reached, same stages as checkout maps (aliases: home/category→browse, add_to_cart→cart, shipform→shipping, paypage→payment). `attempt` is the legacy name, accepted as an alias with a warning; templates also fill `attempt` (browse|cart|checkout|paid) for older readers. A 422 needs `depth` or `rating` |
| `["step","<n>","<text>"]` / `["steps","<n>"]` | steps taken / step count |
| `["duration_s","<seconds>"]` | time to checkout |
| `["blocker","<kind>"]` | first blocker |
| `["wall","captcha"|"login"]` | walls met |
| `["guest","true|false|unknown"]`, `["account_required","true|false|unknown"]` | guest checkout / account needed (yes/no accepted; anything else is rejected) |
| `["pay_used","<code>"]`, `["pay_offered","<code>",...]` | payment used and offered, as /vocab.json pay codes (card, spay, link, btc, ln, ...); aliases such as lightning→ln are normalized with a warning |
| `["btc_route","native|indirect|lightning"]` | BTC paid to the store's own wallet/node, via a processor (Confirmo, BitPay, Coinbase Commerce, OpenNode...), or over Lightning |
| `["shown_before_payment","tax"|"shipping","true|false|unknown"]`, `["shown_before_payment","none"]` | was it shown before the payment step (tri-state; none = neither) |
| `["amount","price|shipping|tax|total","<decimal>","<ISO4217>"]` | money seen |
| `["region","<ZIP3>|US-XX|<country>"]` | coarse location only; full ZIPs are rejected |
| `["agent","<name/version>"]` | agent token (optional) |
| `["delivered","yes|no","<days>"]` | delivery outcome (optional) |
| `["rating","<1-5>","5"]` | rating; `content` is the narrative |
| `["product","<url>"]` | kept as given |

Unknown tags or template fields are not silently dropped: they come back in `warnings` (template response and POST /reviews response).
| `["zap",<id>]`, `["preimage",<hex>]`, `["cashu",<token-hash>]`, `["order_hash",<sha256 of confirmation>]` | proof; marks a verified purchase once checked |

Kind 1 notes with `["t","klickymart"]` and an `r`/`a` store tag are counted as unstructured experiences.

**Privacy.** Use a site-specific key (nsec) only for shopping notes. Delay posting (hours or days) so a note can't be matched to an order time. Location: ZIP3, state or country only; never an address, full ZIP, name, email or order number (use `order_hash`).

**Aggregation.** Per store: distinct pubkeys, depth distribution, blockers, walls, pay used, observed shipping and tax, verified share, recency. A value is "corroborated" only with 2+ distinct keys. Weights: plain note 1, proof attached 2, proof checked 3. Community values never overwrite crawl data; both are shown side by side and every value carries its source. Agent-observed shipping/tax appears on `/landed` as `observed_by_agents`, separate from the crawl/policy totals.

## Payments

Payment is not carried by these kinds; it is referenced by them so that third parties can verify it.

1. **Zaps (NIP-57), preferred for public loops.** The requester zaps the 421 event. The zap request (kind `9734`) MUST include an `e` tag for the 421. The `zap` tag in the 422 references the resulting `9735` receipt. Verifiers check the receipt per NIP-57 (signed by the fulfiller's LNURL provider `nostrPubkey`, `bolt11` amount matches). Limitation: zap receipts are attested by the recipient's LN service, not proven by the payment itself.
2. **Invoice + preimage.** The fulfiller puts a `bolt11` in the 421; the requester includes the `preimage` in the 422. Anyone can check `sha256(preimage) == payment_hash` in the invoice and that the invoice was issued (signed) by a node the fulfiller controls Binding: the store lists `["ln_node","<node pubkey>"]` in its own 31420 (signed by a key that has claimed the domain); a checker recovers the payee from the BOLT11 signature and requires it to be one of those keys. A `bolt11` alone proves the preimage was revealed, not who was paid. Zap proofs likewise require the 9735 to be signed by the store's `["zap_pubkey", <LNURL nostrPubkey>]` (NIP-57).
3. **Ecash (Cashu, NIP-60/61).** For Cashu, the requester sends a nutzap (NIP-61, kind `9321`) to the fulfiller referencing the 421; the 422 `cashu` tag references the nutzap event id. Fedimint: TO-CONFIRM, no Nostr-native receipt standard located.
4. **Off-protocol payment.** Card, cash or other rails MAY be used; the 422 omits payment tags. Such loops are valid but are counted separately (see Reputation).

### Tips on notes and agent profiles (KlickyMart implementation)

KlickyMart lets readers tip 422 reviews, 421 fulfillments, kind-1 notes and agent profiles using existing NIPs only. No new kinds:

- **Lightning: NIP-57 zaps.** The tipper's own signer signs the kind `9734` zap request (`p` = recipient, `e` = note when tipping a note, `amount` in msat, `relays`). KlickyMart's server only fetches the recipient's public LNURL-pay endpoint (LUD-06/LUD-16) and callback to get a `bolt11`. It checks that the invoice amount matches and that `description_hash` = sha256 of the zap request. The tipper pays with their own wallet (WebLN, a browser-only NIP-47 connection, or a `lightning:` QR code). The recipient's LNURL service publishes the kind `9735` receipt. Plain non-zap Lightning tips to a `lud16` are also supported; they leave no Nostr receipt.
- **Cashu: NIP-61 nutzaps.** The recipient publishes kind `10019` (`mint`, `relay`, `pubkey` tags). The tipper's browser swaps their token at one of those mints into proofs that are P2PK-locked (NUT-11) to the `10019` pubkey. Their signer then signs a kind `9321` (`proof`, `u`, `unit`, `p`, `e`, optional `k` tags), which is published to the recipient's relays after the tipper confirms.
- **Custody.** KlickyMart never holds keys, funds, NWC connection strings or Cashu proofs, and publishes nothing itself.
- **Indexing.** Indexers display tips as "tipped". Zap amounts are verified when the receipt is signed by the recipient's LNURL `nostrPubkey`. Nutzap amounts count as "locked" only when every proof is P2PK-locked to the recipient's `10019` key at a mint the recipient listed; otherwise they are "claimed". The "tip-ready" badge (a working `lud16`/`lud06`, or a `10019`) is display only and carries no ranking weight. Nutzaps also add no ranking weight. Only the existing, capped zap-tipper rule under Reputation applies.

## Reputation

A "completed paid loop" for fulfiller `F` is a tuple `(420, 421, 422)` where:

- 421 references the 420 and is signed by `F`;
- 422 is signed by the 420 author, references both, `status` is `accepted`;
- the 422 carries a self-reported payment claim (zap receipt, preimage, or nutzap) of amount ≥ 1 sat paid to `F` (a claim, not verified);
- requester pubkey ≠ `F`.

Indexers SHOULD publish, per pubkey (and per `r` domain): `loops_paid` (count), `sats_paid` (sum), `distinct_requesters` (count), `loops_unpaid` (accepted, no payment claim), `rejected` (count). Raw counts are trivially gamed by self-dealing; indexers SHOULD weight by distinct requesters, requester account age and the requester's own web-of-trust standing, and SHOULD publish their weighting as a NIP-85 trusted assertion (kind `30382`) so clients can choose whose scoring to trust. This NIP does not mandate a single score.

**Count everything, weight by source.** Indexers MUST count every structurally complete loop (420 → 421 → 422, the 422 signed by the 420's author), and MUST record for each loop the requester pubkey and any payment fields it carries (`zap`, `preimage`, `nutzap`). Payment fields are self-reported claims: a self-minted preimage or a zap receipt from the payee's own LNURL service proves nothing about a third party paying. The strongest evidence that a need was met is the 420 author's own signed 422. Raw counts stay public. Each loop and each review is then weighted by the credibility of the account it came from: established, web-of-trust-connected or NIP-05-verified accounts weigh more, and new or anonymous keys weigh less but are never dropped. Stronger proof types MAY add weight. Credibility is itself derived from an account's own loop history, so the weighting sharpens over time. The same source weighting applies to crawl-record disputes and domain reviews.

### Facilitated 421 (for stores that have not claimed their listing)

When an agent pays a store that has no claimed key, there is no fulfiller to sign the 421. An indexer MAY act as **facilitator**: it checks the agent's proof and signs a 421 with a **separate facilitator key** (never its crawler key), returned to the agent to publish. It never publishes it itself.

Tags (in addition to the 421 tags above where they apply):
- `["r","<domain>"]` and `["on_behalf_of","<domain>"]`: the store the purchase was at.
- `["role","facilitator"]`: this 421 is not from the store.
- `["verification","verified-preimage"|"verified-zap"|"unverified-claim"]`: what the facilitator checked.
  - `verified-preimage`: `sha256(preimage) == payment_hash` of the supplied `bolt11` (and the invoice is unexpired at submission or was paid).
  - `verified-zap`: a supplied 9735 receipt validates per NIP-57 (signature, embedded 9734, amount).
  - `unverified-claim`: e.g. a redacted receipt hash (`order_hash` = sha256 of the confirmation); the facilitator could not check it and says so.
- `["proof", <type>, <value>]` as above (the preimage, zap receipt id, or the hash; never the receipt itself).
- `content` states plainly what was checked, e.g. "Facilitator checked a Lightning preimage against the invoice. The store did not sign or confirm this." A facilitated 421 MUST NOT say or imply the store confirmed anything.

Rules: facilitators rate-limit per pubkey and per IP; clients weigh facilitated 421s below store-signed ones and `unverified-claim` lowest. **Once a store claims its listing**, only 421s signed by the store's key count toward its paid loops from the claim time on; earlier facilitated 421s stay visible as history, labelled facilitated.

**KlickyMart implementation (2026-10-30).** `POST /facilitate` (MCP `facilitate_purchase`) signs facilitated 421s with the facilitator key `npub1zw8a7v4eyagkd0eqpqle0c06xxnvyuwaps2hyk3xykqgfsa49h9srq3694` (hex `138fdf32b9275166bf20083f97e1fa31a6c271dd0c15725a26258084c3b52dcb`), separate from the crawler key. Extra tags: `["p",<agent>]`, optional `["e",<420>,"","need"]`, `["bolt11",...]`, `["amount",<msat>]`, `["L","klickymart.facilitated"]`. Refused (409) once the domain has a claim. Rate limits: 5/agent/day, 1/agent/store/day, 20/IP/day, 500/day overall.

**Claims make facilitated 421s history (KlickyMart, 2026-10-30).** When a domain gains a claim, every 422 that cites a KlickyMart-facilitated 421 for it gets `proof_status = "facilitated-history"`: still shown and labelled, never "store-confirmed", not a verified payment, and no proof weight in scoring.

**Deletions.** Indexers honour NIP-09 kind 5 only when the deletion's pubkey is the deleted event's author, remove the event plus anything derived from it (review rows, notes, tips, aggregates), and keep a tombstone (id + author) so later relay copies are not re-ingested.

### Tips on 422 reviews

Reviews (422 shopping-experience notes) can be zapped (NIP-57). A review MAY carry `["lud16","name@domain"]` so readers can zap its author directly; otherwise clients use the author's kind 0 `lud16`.

Indexers read 9735 zap receipts whose `e` tag points at a 422 and SHOULD show, per review and per reviewer: tip count, distinct tippers and sats. For ranking:
- only **distinct tippers** count (one tipper zapping ten times is one tip); a zap from the review's own author (`P` of the 9734 == review pubkey, or tipper == author) is ignored;
- the weight added is **capped** (for example `1 + min(0.5, 0.1 * distinct_tippers)`), so tips amplify a review but cannot dominate;
- receipts are validated per NIP-57 where possible; unvalidated receipts count in the display, not in the weight.

**KlickyMart implementation (2026-10-30).** Tips are read from 9735 receipts on recent 422 / kind-1 note ids; shown on store pages, `/chart`, `/chart.json` (`community.tips`), `/tips.json?domain=` (per review, per reviewer) and `/curators.json`. Weight is `1 + min(0.5, 0.1 * distinct validated tippers)`; a tip is validated when both the 9735 and its embedded 9734 signatures check and the invoice has an amount.

**Curator record.** Indexers MAY publish a per-tipper summary (who tipped which reviews, sats and count) so tippers are visible as curators; this is public data already present in the receipts.

### Flags (anti-gaming, explainable)

Indexers SHOULD flag rather than hide. A flagged note stays public and is labelled with the public signals behind the flag; only its ranking weight drops (KlickyMart: one weak signal halves it, a strong signal or two independent signals set it to zero). Signal families KlickyMart uses: bursts of brand-new keys around one store, suspiciously regular timing, near-duplicate notes across keys, circular or tip-only tipping (those tips stop adding weight), data implausible against other notes, invoices or the crawl, public same-operator hints (e.g. one lightning address on several keys), and community reports. Thresholds are not published in detail. IP addresses are never used.

**Reports** are NIP-56 kind 1984 events with `["e", <note id>, <reason>]`, read from relays or sent to `POST /flag`. They count once per reporter key, need 2+ independent reporters, are rate-limited, and reporters are checked for gaming too.

**Appeal**: the author can reply to the note with context or delete it (NIP-09). Flags are listed with reasons at `/flags.json`.

## Businesses

Domain identity for handshake events uses the same NIP-05 claim as site records (see "Publishers, corrections, trust"). A pubkey that holds the domain's `_` NIP-05 entry may publish 421s with `["r","<domain>"]` and accumulate loop reputation under that domain. Reputation earned before a claim stays with the individual fulfiller pubkeys. An `r` tag alone never means the business is speaking.

## Private needs

A 420 MAY be private. Two options:

- **Directed:** encrypt `.content` with NIP-44 to each `p` recipient (one event per recipient, or gift-wrapped per NIP-59). Public tags SHOULD be minimized to `p` and `expiration`.
- **Public need, private details:** keep a coarse public description and `t` tags, and exchange specifics over NIP-17 DMs.

Private loops can still be counted for reputation only if the 421/422 and payment proof are public; otherwise they are invisible to indexers by design.

## Relation to NIP-90 (Data Vending Machines)

NIP-90 defines job requests (`5000–5999`), results (`6000–6999`) and feedback (`7000`) for computational jobs sold by service providers, with kind numbers tied to job types. This NIP differs in three ways:

1. **Scope.** Any need, physical or digital, from a human or an agent, is one kind (`420`); categorisation is by tags, not by kind range.
2. **Explicit close.** NIP-90 has no requester-signed acceptance event. Here `422` is the requester's signed acceptance and carries or references payment, which is what makes reputation computable.
3. **Proof.** `421` carries typed proof of real-world fulfillment (tracking, order refs, hashes), not just a job output.

The two compose: a `420` with `["k","5xxx"]` can be fulfilled by a DVM whose `6xxx` result is referenced from a `421` `["proof","event","<id>"]`.

Related work worth reading before submission: NIP-15 (marketplace, bids `1021/1022`), NIP-99 (classifieds `30402`), NIP-69 (P2P orders `38383`), NIP-85 (trusted assertions), open PRs #2115 (Stars & Reviews), #1914 (rating/review), #2285/#2320 (Agent Reputation Attestations, kind `30085`).

## Security and abuse

- **Sybil / wash loops.** One actor controlling requester and fulfiller keys can create paid loops by paying themselves; the cost is only routing fees. Mitigations: count `distinct_requesters` rather than loops; weight requesters by web-of-trust distance and age; discount loops between keys that frequently transact only with each other; publish the weighting so it can be audited. "Can't be faked without paying" holds only in the weak sense that every fake loop moves real sats, usually back to oneself.
- **Zap receipt trust.** NIP-57 receipts are produced by the recipient's LNURL server; a malicious server can fabricate them. Indexers still count zap-receipt tips, but record the proof type and source account so a fabricated-receipt pattern (one LNURL server, low-credibility tippers) can be discounted; preimage or ecash proofs MAY carry extra weight.
- **Fake proof.** `421` proof is a claim. Only the requester's `422` confers reputation.
- **Griefing.** Requesters can withhold 422 after receiving goods. Fulfillers SHOULD demand prepayment or escrow (out of scope) for valuable needs; indexers MAY publish requester-side stats (`needs_posted`, `accept_rate`).
- **Spam.** Relays MAY require NIP-13 PoW or payment to accept 420s.
- **Privacy.** Public loops reveal who paid whom and roughly how much. Use private needs or off-protocol rails where that matters.
- **Impersonation.** Domain attribution relies solely on NIP-05; clients MUST NOT treat an `r` tag alone as the business speaking.

## Examples

Unsigned; `id`, `pubkey`, `sig` are placeholders.

Site record from a crawler:

```json
{
  "kind": 31420,
  "pubkey": "<crawler-pubkey-hex>",
  "created_at": 1793291300,
  "tags": [
    ["d", "example-store.com"], ["r", "example-store.com"], ["L", "nip-xx"],
    ["t", "shopping"], ["t", "elec"], ["name", "Example Store"],
    ["l", "status:crawled", "nip-xx"], ["l", "tos:ok", "nip-xx"],
    ["l", "ag:3", "nip-xx"], ["l", "co:2", "nip-xx"], ["l", "guest:yes", "nip-xx"],
    ["l", "ar:cap", "nip-xx"],
    ["l", "pay:card", "nip-xx"], ["l", "pay:lightning", "nip-xx"], ["l", "pay:btc-onchain", "nip-xx"],
    ["l", "pay_online:card", "nip-xx"], ["l", "pay_online:ln", "nip-xx"], ["l", "pay_online:btc-onchain", "nip-xx"],
    ["l", "btc:3", "nip-xx"], ["l", "btcpriv:noacct", "nip-xx"], ["l", "btcpriv:selfhosted", "nip-xx"],
    ["l", "kyc:none-stated", "nip-xx"],
    ["crawled_at", "1793291247"], ["v", "0.3-draft"], ["license", "CC0-1.0"],
    ["vantage", "single-datacenter"], ["crawler", "ExampleMapBot/0.2", "https://example.org/bot"]
  ],
  "content": "{\"d\":\"example-store.com\",\"cat\":[\"elec\"],\"v\":\"0.3-draft\",\"ts\":1793291247,\"status\":\"crawled\",\"tos\":\"ok\",\"ag\":3,\"co\":2,\"guest\":true,\"pay\":[\"card\",\"ln\",\"btc\"],\"pay_online\":[\"card\",\"ln\",\"btc\"],\"pay_instore\":[],\"pay_unscoped\":[],\"btc\":3,\"btc_conf\":\"med\",\"evu\":[\"https://example-store.com/help/payments\"]}",
  "id": "<id>", "sig": "<sig>"
}
```

Site that refused agents (tags only; content follows the same schema):

```json
{
  "kind": 31420,
  "pubkey": "<crawler-pubkey-hex>",
  "created_at": 1793291400,
  "tags": [
    ["d", "bigshop.example"], ["r", "bigshop.example"], ["L", "nip-xx"], ["t", "shopping"], ["t", "gen"],
    ["l", "status:agents-not-welcome", "nip-xx"], ["l", "tos:unknown", "nip-xx"],
    ["l", "anw:http-403", "nip-xx"], ["l", "ar:403", "nip-xx"], ["l", "ar:rb_ai", "nip-xx"], ["l", "ag:0", "nip-xx"],
    ["crawled_at", "1793291390"], ["v", "0.3-draft"], ["license", "CC0-1.0"], ["vantage", "single-datacenter"]
  ],
  "content": "{...}", "id": "<id>", "sig": "<sig>"
}
```

A need that points at a directory record, and its acceptance:

```json
{
  "kind": 420,
  "pubkey": "<buyer-pubkey-hex>",
  "created_at": 1793300000,
  "tags": [
    ["t", "shopping"], ["r", "example-store.com"],
    ["a", "31420:<crawler-pubkey-hex>:example-store.com", "wss://relay.example"],
    ["amount", "40000000", "msat"], ["payment", "zap"], ["expiration", "1793836800"]
  ],
  "content": "Buy 2x USB-C 100W cables from example-store.com, pay merchant in Lightning, ship to my locker.",
  "id": "<need-id>", "sig": "<sig>"
}
```

```json
{
  "kind": 422,
  "pubkey": "<buyer-pubkey-hex>",
  "created_at": 1793400000,
  "tags": [
    ["e", "<fulfillment-id>", "wss://relay.example", "fulfillment"],
    ["e", "<need-id>", "wss://relay.example", "need"],
    ["p", "<agent-pubkey-hex>"], ["amount", "42000000"], ["tip", "2000000"],
    ["zap", "<9735-receipt-id>"], ["status", "accepted"]
  ],
  "content": "Arrived, thanks.",
  "id": "<id>", "sig": "<sig>"
}
```

## Kind 1423: Store suggestion (community submission)

A regular event anyone can publish to suggest a store for indexing. It carries no store facts: an indexer queues the domain for its own gated crawl (robots.txt and terms first) and never copies claims from the note.

```json
{ "kind": 1423, "content": "Small coffee roaster, takes Lightning at checkout.",
  "tags": [["r", "roaster.example"], ["t", "groceries"], ["proof", "https://roaster.example/checkout-help"], ["t", "klickymart"]] }
```

- `r` (required): the store domain. Indexers keep only the bare registrable domain (paths, queries, sub-domains and referral parameters are stripped).
- `t` (optional): a category hint. The hashtag `klickymart` is ignored as a category.
- `proof` (optional): an https page on the same store. Off-site URLs are dropped.
- `content`: a short note, at most 280 characters kept, with links removed.

The signature is the submitter identity. KlickyMart also accepts the same fields unsigned via `POST /submit` (anonymous or a salted agent id) and the MCP tool `submit_store`.

**Number check (2026-10-30).** `1423` is not in the NIP README kinds table (nearest: `1337` code snippets, `1617`–`1633` git). GitHub search of nostr-protocol/nips for "kind 1423" and "1423" matched only PR #1423 (NIP-113, by PR number) and PR #1816 (workout events, kind 1301); neither defines kind 1423. No collision found; TO-CONFIRM at submission.

### Store claim by DNS TXT

The store owner publishes a TXT record at `_klickymart.<domain>` containing their npub (bare, or `klickymart-claim=npub1...`) and sends a kind 1423 signed by that key with tags `["r", "<domain>"]` and `["claim", "dns"]` (KlickyMart: `POST /claim/dns`). The indexer checks the TXT itself. A kind 1423 with `["claim", "revoke"]` signed by the same key revokes the claim; removing the TXT revokes it at the next re-check. Claim events are not store suggestions and are not queued for crawling.

### Trust tiers for listed stores (`trust_tier`)

Indexers SHOULD label, never hide. KlickyMart publishes `trust_tier`, `trust_why[]` and `src` (`crawler` | `community`) with every record:

| tier | when |
|---|---|
| `flagged` | a strong abuse signal: spam note, affiliate redirect, look-alike of an indexed domain (edit distance <= 2, confusable or punycode spelling), more than 3 sub-domains of one domain from one submitter |
| `unverified` | newly submitted, or crawler-indexed with no shopper basis |
| `seen` | >= 3 weighted distinct unflagged keys with visit-basis notes (421, or 422 `basis=visit`) in 60 days; new or anonymous keys weigh 0.5; >= 2 real keys (>= 30 days old or unflagged notes on >= 2 other stores); the submitter, keys first seen within 24 h of the submission, and keys with reputation below -3 do not count; drops back when > 40% of basis notes are flagged |
| `verified` | any one of: a verified payment proof (422) from an unflagged key that is not the submitter, a store claim (DNS TXT plus a signed claim, or NIP-05 on the domain plus a self-signed 31420), or a crawler-observed protocol endpoint (`/.well-known/ucp` present, or a real HTTP 402 challenge from the indexer's own probe; directory-claimed rails do not count) |

Submitter reputation = submissions whose store reached `seen` or `verified`, minus 2 x flagged submissions.

## Endpoint binding (provisional kind 31431) and signed results (KlickyMart M2)

**Status: draft, kind number provisional.** The design picks no number and rules out 30078. 31431 is an internal placeholder
constant (`NOSTR_KIND_ENDPOINT_BINDING`). **Before anything public it needs the nips kind-list + open-PR collision check
re-run** (plus live relay usage). It was moved off 31421 on 2026-11-01 because KlickyMart's draft product offers already use 31421. Read-only check 2026-11-01: `31431`
absent from https://github.com/nostr-protocol/nips/blob/master/README.md (raw README fetched) and unused elsewhere in this repo;
open PRs and relay usage not checked for 31431. Nothing is published under it. Implemented in `site/worker/src/endpoint-binding.ts` and `site/worker/src/signed-result.ts`.

- **Binding event.** Addressable, one per store key, `["d","klickymart-endpoints"]`. Content is canonical JSON (keys
  sorted, no whitespace) with ONLY the v9.2 §2 fields: `{"endpoints":{...},"expires_at":<unix>,"version":<int>}` with
  endpoints from `bolt12_offer`, `node_id` (66 hex), `lud16`, `lnurl`, `cashu_mints` (https URLs), or
  a revoke. Any other field on a non-revoke state is rejected. **Revoke:** any validly signed event from the key, on this
  kind and d tag, with `"revoked":true` is terminal regardless of version, `created_at`, skew or extra fields;
  `expires_at`/`endpoints` on a revoke are ignored and never used. No settlement modes: those are a per-order claim the
  harness checks (v9.2 §3). Payment strings are data: shape-checked, never fetched.
- **Versioning.** A new state needs both `version` and `created_at` strictly higher, else `conflict`. `created_at` more than
  skew S ahead is rejected. A version jump above a threshold is `conflict`. Same version with different content is
  `conflict`, and the conflict carries both signed events. Revocation is terminal for the store key and beats any version,
  `created_at` and S; recovery is a new store key with no inherited history. **Conflict is permanent for the key**;
  results show the current state beside it (`current_binding`).
- **Version index.** A permanent per-key index version -> (content hash, `created_at`, event id) of every accepted
  version. A second event for a known version with different content is `conflict` regardless of `created_at`. If the
  old bytes already left the capped history, the conflict carries the new signed event plus the stored hash and id of
  the old one, marked `evidence_hash_only_old_side` (weaker evidence; results list it in `conflict_refs`).
- **Evidence.** Every accepted state and all evidence is kept: the first state, every conflict pair and the revoke are
  never dropped; only ordinary superseded states are capped (last 32, a starting guess). Ignored events (after a revoke,
  future-dated, stale replays) are not stored: a per-key counter and the hash of the last one only.
- **Status** (observed): `matches_observed_binding`, `url_only`, `mismatch`, `conflict`, `expired`, `revoked`, `none`,
  `unknown`. Expired, revoked and `url_only` are never a match. The strongest claim is "matches the latest binding
  KlickyMart saw". A signature gives accountability, not truth.
- **Signed results.** `GET /open-store/head` and `GET /open-store/binding?pubkey=&nonce=` return payloads signed (BIP-340
  over `sha256("klickymart-result-v1\n" + canonical JSON)`, heads with `klickymart-head-v1`) by the KlickyMart result key.
  A result names its snapshot id and sequence, echoes the nonce, carries the binding hash and the raw signed events, and
  types every field with a provenance; `payment_bound_to_order` and `settlement_mode_verified` are always `unknown`.
  Nothing in a result is a score, rank or weight, and nothing that ranks reads bindings.
- **Harness checks** (reference: `verifyResult`): pinned signer, nonce echo, head unexpired and sequence ≥ high-water,
  result bound to the head, max age, TTL caps clamp signed expiries, harness-only fields `unknown`, raw events replayed
  to confirm any `matches`/`url_only` claim. Acceptance ends at the earliest of result, head and binding expiry. When
  cached state lapses, KlickyMart-dependent payments fail closed; relay-only reading is opt-in.
- **Key lifecycle (M3, `KM_KEY_LIFECYCLE`, default OFF; `site/worker/src/key-lifecycle.ts`; Satoshi final M3 rules,
  Matt OK 2026-11-01).** Hash-linked key statements (`klickymart-keystmt-v1`: key, seq, prev hash, `next_key_digest` =
  sha256 of the next x-only key, revocation key, `created_at`, `expires_at`). A handover is valid only to the
  pre-announced successor and carries the previous key's signature plus the new key's proof of possession. Statements
  are immutable. Nothing is published to Nostr.
  1. **TTL cap.** `HARD_MAX_S` = 604800 (7 days) is compiled into the verifier. Config (`KM_KEY_TTL_CAP_S`, harness
     `ttlCapS`) may lower it, never raise it. Effective expiry = min(`expires_at`, `created_at` + min(`HARD_MAX_S`, config));
     an over-long expiry is clamped, not rejected and not trusted. Raising the cap is a code change.
  2. **Overlap 0.** The old key stops verifying the moment the handover statement is accepted. Normal path: stage the
     handover (`stageHandover`, not yet in the lineage) and load the successor's secret as `KM_RESULT_SK_NEXT_HEX`; the
     existing daily cron (`writeDailyHead` -> `cronHandover`) promotes it right before writing the day's head, and the
     Worker signs with whichever loaded key the current statement names, so there is no 503 gap. A handover stored any
     other way is allowed and fails closed (503) until the Worker holds the new key. No new cron, no higher frequency.
  3. **Revocation key.** A revoke (`klickymart-keyrevoke-v1`) only revokes, covers the target and all descendants and
     beats any handover regardless of timestamps. Only the CURRENT revocation key can revoke; a replaced one can't.
     Rotating it needs both the signing key and the old revocation key, and takes effect when accepted.
  4. **Fork = terminal.** Two validly signed, conflicting statements at one lineage position make the whole lineage
     terminal: every result under it stops verifying, and both statements are kept as evidence.
  5. **Heads.** With the switch on, `key_statement_hash` is mandatory on heads and results; the Worker refuses to sign
     (503) without a current, unrevoked statement for a loaded key. Pre-M3 heads are not migrated; they expire by
     their 25 h TTL. With the switch off, results keep `key_statement_hash: null`.
  6. **Rotation fork.** Two valid but conflicting revocation-key rotations for one statement are a fork: terminal, fail
     closed, both kept. "Most recent" is never picked (`created_at` is self-asserted).
  7. **Revoke-to-disown.** A revoke stops future verification but does not erase the past: a result validly signed
     under a later-revoked statement is classified `signed_then_revoked` (also `signed_then_superseded`,
     `signed_then_expired`, `signed_under_compromised_lineage`) so a harness can show KlickyMart signed it. A revoke
     carries exactly `type`, `v`, `target`, `revocation_key`, `created_at`: no store field, no claim about any store.
  Harnesses persist revokes (restoring an older backup cannot undo one) and pin the root on two or more agreeing
  channels.
- **OpenTimestamps for key records (M3, `KM_KEY_OTS`, default OFF; `site/worker/src/key-ots.ts`, migration 0021).**
  With it off nothing changes (records carry no `notbefore`, nothing is stamped). With it on:
  1. Every key statement, revoke and revocation-key rotation is stamped (digest = record hash); proofs are stored beside
     the record (`km_key_ots`) and upgraded by the existing daily cron. Stamping runs in the background and never blocks
     signing; a failure leaves the record unstamped. An anchor counts only at >= `CONF` = 6 confirmations.
  2. Records embed `notbefore` = {height, hash} of a recent Bitcoin block. A confirmed anchor more than `FRESH_K` blocks
     after `notbefore` (default 36, `KM_KEY_OTS_FRESH_K`, compiled max 144, PENDING SATOSHI; TODO measure real
     calendar-to-block latency), a `notbefore` naming a block that isn't there, or an anchor with no `notbefore` = stale
     and invalid.
  3. A is strictly before B only if anchor(A) < notbefore(B), heights only, never block timestamps; overlap = tie.
  4. Forks stay terminal for the whole lineage. Archived results record the key statement's anchor height as an
     `observed` provenance field only; no salvage.
  5. Conflicting rotations / a fork at one position: unchanged, fail closed, no anchor tiebreak.
  6. Old revocation key R1 after R1 -> R2: an R1 revoke strictly before the rotation is valid and terminal; strictly
     after is ignored as stale; tie, overlap or unconfirmed = the revoke wins. A rotation never erases a revoke unless it is
     strictly before it.
  7. In that dispute only, results fail closed (`disputed`) while anchors are pending. It resolves when all relevant
     anchors have `CONF` confirmations, or at newest `notbefore` + `FRESH_K` + `CONF` blocks, when an unanchored record is
     stale. A revoke judged stale was never valid (the lineage resumes); a valid revoke is latched terminal forever.
  8. Verifiers inject Bitcoin block headers (`BlockHeaderSource`; several sources combine, a header counts only if all
     answering sources agree, tip = lowest). No headers = anchors unconfirmed, which fails closed only in a dispute;
     normal operation never needs OTS.
  Proof verification and calendars are injected interfaces (`OtsProofVerifier`, `OtsCalendar`); no OTS library is
  bundled and no calendar client ships yet (PENDING). Nothing is published (no NIP-03 kind 1040 events). `GET /open-store/keys` serves the stored records (both switches on).
- **Not yet:** snapshot heads written by the daily snapshot step (M4).
- **Head writes (M2):** the existing daily cron writes one head after relay catch-up, only when `KM_SIGNED_RESULTS` is on.
  `HEAD_TTL_S` = 90000 (25 h: daily write + 1 h slack for cron jitter; Satoshi 2026-11-01); `RESULT_TTL_S` stays 600. No
  on-demand writes, no extra cron; a missed day fails closed (503). Freeze-window tradeoff: a frozen or replayed head can
  pass for up to 25 h, the same as the data cadence (cf. TUF's timestamp role: its expiry bounds how long a freeze attack
  goes unnoticed; the harness's sequence high-water still blocks rollback to an older head).
- **snapshot_digest (guard):** heads carry `snapshot_digest` (sha256 over the snapshot data) inside the signed payload, so
  two datasets under one `snapshot_id` label yield different signed heads (equivocation is detectable). The Worker has no
  snapshot data files to hash at head-write time (data comes from KV/D1/embedded fixtures), so M2 writes label-only heads
  (`snapshot_digest` null) and **never serves them**: with `KM_SIGNED_RESULTS` on, `/open-store/*` answers 503 "head has no
  snapshot_digest", and `verifyResult` rejects a head without one. The digest source and Merkle inclusion proofs are M4.
- **Ignored counter:** counts each distinct ignored event id once (re-receipts are duplicates); stale replays (lower version,
  or known content re-signed with an earlier created_at) count. Only event ids are kept (capped), never content.
- **Switches:** `KM_ENDPOINT_BINDINGS`, `KM_SIGNED_RESULTS` default OFF; only `1`/`true`/`on` enables them. Kind 31431 is an internal placeholder pending the NIP kind-collision check; nothing is published to Nostr under it.

## Numbering and kind checks (checked 2026-10-29)

Checked against `https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md` and open PRs (GitHub API, ~400 open PRs, titles; GitHub issue search for kind strings).

- **NIP number.** Numbering is no longer sequential. Merged NIPs include `01…99` (with gaps) and hex-style IDs `5A, 7D, A0, A3, A4, B0, B7, C0, C7, CC, CD, F4`. Open PR titles already claim many others (e.g. `100, 101, 102, 113, 116, 122, …, 800`, `A1, A5, A7, AA–AE, B9, BB, BC, C1, C4, CF, D8, DA–DC, EE, F5–F7, FB, FC, FE`). Maintainers assign numbers at merge and new proposals are customarily submitted as "NIP-XX". There is therefore no well-defined "next" number. Recommendation: submit as **NIP-XX**; if a number must be suggested, `A6` appears unused in both the README and open PR titles (TO-CONFIRM at submission time). No decimal number after 99 is free of open PR claims at the low end (100–102 are claimed).
- **Kinds 420/421/422.** Not in the README kinds table (nearest registered: `443–445` Marmot, `818`). GitHub issue/PR search for "kind 420/421/422" returned only unrelated items (issue/PR numbers 420, 421, 422). **No collision found.** Limitation: PR *diff* contents could not be code-searched without authentication; TO-CONFIRM by grepping open PR branches before submission.
- **Kind 1423** (store suggestion, added 2026-10-30): no collision found; see the Kind 1423 section.
- **Kind 31420.** Not in the README; search returned 0 hits. No collision found (same limitation).

## Open questions

1. Label namespace string: `nip-xx` until a number is assigned; does every publisher re-sign on assignment?
2. Should `pay:` be the union of all scopes (current) or online only, since agents mostly care about online checkout?
3. Payment proof for invoice + preimage and Fedimint (see TO-CONFIRM items in Payments).

Resolved (2026-10-29): payment tags use readable names; a merchant's NIP-05-verified record outranks third-party corrections, with no protocol-level rate limits; ToS-banned sites get a bare record (name, URL, status, ToS quote).
