NIP-XX
======

Need / Fulfillment / Acceptance Handshake
-----------------------------------------

`draft` `optional`

> Number: **NIP-XX** (unassigned). See "Numbering and kind checks" at the end. Kinds requested: `420`, `421`, `422` (regular), `31420` (addressable, companion crawl records, see CRAWL-RUBRIC.md).

This NIP defines a three-event handshake that any party, human or agent, can use to post a need, claim fulfillment with proof, and close the loop with acceptance and payment. Higher-level protocols (commerce search, task markets, agent services) layer on top of it. A party's reputation is derived from completed, paid loops.

## Kinds

| kind  | name        | meaning                                                         |
|-------|-------------|-----------------------------------------------------------------|
| `420` | Need        | "I have a need", with an optional offered payment               |
| `421` | Fulfillment | "I met your need; here is proof", with an optional amount owed |
| `422` | Acceptance  | "Yes, you met my need", with payment and/or an optional tip    |

All three are regular (non-replaceable) events. A loop is the chain `420 → 421 → 422`.

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

## Businesses and domain-tagged reviews

No party publishes as a business without that business's key. Specifically, a site, crawler or agent MUST NOT generate or hold keys on behalf of a business that has not consented.

- **Reviews about a business** are events signed by the reviewer and tagged with the business domain: `["r","example.com"]` plus `["L","nip-xx"]`/`["l","review","nip-xx"]` (NIP-32 labels). The crawler's per-domain records (kind `31420`, see CRAWL-RUBRIC.md) are one such source. Reviews are statements by their author, not by the business.
- **Claiming a domain.** A business proves control of a pubkey for its domain with NIP-05: `https://example.com/.well-known/nostr.json` contains `{"names":{"_":"<hex pubkey>"}}`. Clients then treat that pubkey as the domain's voice: it may reply to reviews, publish 421s with `["r","example.com"]`, and accumulate loop reputation under that domain. Reputation earned before a claim stays attributed to the individual fulfiller pubkeys; indexers MAY show it alongside the domain.
- **Revocation.** If the NIP-05 record changes, prior events stay signed by the old key; clients SHOULD show the current mapping and the date it was observed.

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

## Numbering and kind checks (checked 2026-10-29)

Checked against `https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md` and open PRs (GitHub API, ~400 open PRs, titles; GitHub issue search for kind strings).

- **NIP number.** Numbering is no longer sequential. Merged NIPs include `01…99` (with gaps) and hex-style IDs `5A, 7D, A0, A3, A4, B0, B7, C0, C7, CC, CD, F4`. Open PR titles already claim many others (e.g. `100, 101, 102, 113, 116, 122, …, 800`, `A1, A5, A7, AA–AE, B9, BB, BC, C1, C4, CF, D8, DA–DC, EE, F5–F7, FB, FC, FE`). Maintainers assign numbers at merge and new proposals are customarily submitted as "NIP-XX". There is therefore no well-defined "next" number. Recommendation: submit as **NIP-XX**; if a number must be suggested, `A6` appears unused in both the README and open PR titles (TO-CONFIRM at submission time). No decimal number after 99 is free of open PR claims at the low end (100–102 are claimed).
- **Kinds 420/421/422.** Not in the README kinds table (nearest registered: `443–445` Marmot, `818`). GitHub issue/PR search for "kind 420/421/422" returned only unrelated items (issue/PR numbers 420, 421, 422). **No collision found.** Limitation: PR *diff* contents could not be code-searched without authentication; TO-CONFIRM by grepping open PR branches before submission.
- **Kind 31420.** Not in the README; search returned 0 hits. No collision found (same limitation).
