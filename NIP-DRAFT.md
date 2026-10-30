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
2. **Invoice + preimage.** The fulfiller puts a `bolt11` in the 421; the requester includes the `preimage` in the 422. Anyone can check `sha256(preimage) == payment_hash` in the invoice and that the invoice was issued (signed) by a node the fulfiller controls (TO-CONFIRM: binding a node pubkey to a Nostr pubkey; a `bolt11` alone proves the preimage was revealed, not who paid).
3. **Ecash (Cashu, NIP-60/61).** For Cashu, the requester sends a nutzap (NIP-61, kind `9321`) to the fulfiller referencing the 421; the 422 `cashu` tag references the nutzap event id. Fedimint: TO-CONFIRM, no Nostr-native receipt standard located.
4. **Off-protocol payment.** Card, cash or other rails MAY be used; the 422 omits payment tags. Such loops are valid but are counted separately (see Reputation).

## Reputation

A "completed paid loop" for fulfiller `F` is a tuple `(420, 421, 422)` where:

- 421 references the 420 and is signed by `F`;
- 422 is signed by the 420 author, references both, `status` is `accepted`;
- the 422 carries a verifiable payment (zap receipt, preimage, or nutzap) of amount ≥ 1 sat paid to `F`;
- requester pubkey ≠ `F`.

Indexers SHOULD publish, per pubkey (and per `r` domain): `loops_paid` (count), `sats_paid` (sum), `distinct_requesters` (count), `loops_unpaid` (accepted, no verifiable payment), `rejected` (count). Raw counts are trivially gamed by self-dealing; indexers SHOULD weight by distinct requesters, requester account age and the requester's own web-of-trust standing, and SHOULD publish their weighting as a NIP-85 trusted assertion (kind `30382`) so clients can choose whose scoring to trust. This NIP does not mandate a single score.

**Count everything, weight by source.** Indexers MUST count every verifiable paid loop, including cheap zap-receipt tips, and MUST record for each loop the requester (tipper) pubkey and the proof type (`zap`, `preimage`, `nutzap`). Raw counts stay public. Each loop and each review is then weighted by the credibility of the account it came from: established, web-of-trust-connected or NIP-05-verified accounts weigh more, and new or anonymous keys weigh less but are never dropped. Stronger proof types MAY add weight. Credibility is itself derived from an account's own loop history, so the weighting sharpens over time. The same source weighting applies to crawl-record disputes and domain reviews.

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

## Numbering and kind checks (checked 2026-10-29)

Checked against `https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md` and open PRs (GitHub API, ~400 open PRs, titles; GitHub issue search for kind strings).

- **NIP number.** Numbering is no longer sequential. Merged NIPs include `01…99` (with gaps) and hex-style IDs `5A, 7D, A0, A3, A4, B0, B7, C0, C7, CC, CD, F4`. Open PR titles already claim many others (e.g. `100, 101, 102, 113, 116, 122, …, 800`, `A1, A5, A7, AA–AE, B9, BB, BC, C1, C4, CF, D8, DA–DC, EE, F5–F7, FB, FC, FE`). Maintainers assign numbers at merge and new proposals are customarily submitted as "NIP-XX". There is therefore no well-defined "next" number. Recommendation: submit as **NIP-XX**; if a number must be suggested, `A6` appears unused in both the README and open PR titles (TO-CONFIRM at submission time). No decimal number after 99 is free of open PR claims at the low end (100–102 are claimed).
- **Kinds 420/421/422.** Not in the README kinds table (nearest registered: `443–445` Marmot, `818`). GitHub issue/PR search for "kind 420/421/422" returned only unrelated items (issue/PR numbers 420, 421, 422). **No collision found.** Limitation: PR *diff* contents could not be code-searched without authentication; TO-CONFIRM by grepping open PR branches before submission.
- **Kind 31420.** Not in the README; search returned 0 hits. No collision found (same limitation).

## Open questions

1. Label namespace string: `nip-xx` until a number is assigned; does every publisher re-sign on assignment?
2. Should `pay:` be the union of all scopes (current) or online only, since agents mostly care about online checkout?
3. Payment proof for invoice + preimage and Fedimint (see TO-CONFIRM items in Payments).

Resolved (2026-10-29): payment tags use readable names; a merchant's NIP-05-verified record outranks third-party corrections, with no protocol-level rate limits; ToS-banned sites get a bare record (name, URL, status, ToS quote).
