NIP-XX (DRAFT, NOT SUBMITTED)
=============================

Need / Fulfillment / Acceptance handshake
-----------------------------------------

`draft` `optional` — kind numbers provisional. This is a focused extract of the handshake section of
[`NIP-DRAFT.md`](../../NIP-DRAFT.md) plus validation rules as implemented in
[`site/worker/src/handshake.ts`](../../site/worker/src/handshake.ts). It has not been submitted to nostr-protocol/nips
and will not be without explicit approval. Where this file and `NIP-DRAFT.md` differ, `NIP-DRAFT.md` wins until reconciled.

## Kinds

| kind | name | author | meaning |
|---|---|---|---|
| `420` | Need | requester | "I have a need", optional offered payment |
| `421` | Fulfillment | fulfiller | "I met your need", proof, optional amount owed |
| `422` | Acceptance | requester (the 420 author) | "Yes, you met my need", payment and/or optional tip, or `rejected` |

All three are regular events: later events must never replace the proof in earlier ones.

## Amounts

All amounts are decimal strings of millisatoshis: no sign, no leading zeros, no exponent, at most 21e6 BTC
(2.1e18 msat). A 420 `amount` MAY carry a third element naming an ISO 4217 unit as an indication only; settlement is in bitcoin.

## Kind 420: Need

- `amount` (optional, at most one): `["amount","<msat>","<unit default msat>"]`
- `payment` (optional, repeatable): accepted settlement methods, e.g. `["payment","zap"]`, `["payment","cashu","<mint>"]`
- `p` (optional, repeatable): directed need; only listed pubkeys are expected to fulfil
- `t`, `r`, `a` (`31420:<pk>:<domain>`), `expiration` (NIP-40), `relays`, `k` (optional)
- MUST NOT carry `e` tags with marker `need` or `fulfillment`.

## Kind 421: Fulfillment

- `e` (required, exactly one with marker `need`): `["e","<420-id>","<relay>","need"]`
- `p` (required, exactly one): the 420 author
- `amount` (optional, at most one): amount owed, msat
- `bolt11` (optional): invoice for the amount owed
- `proof` (optional, repeatable): `["proof","<type>","<value>",...]`, type ∈ `url`, `sha256` (64 hex), `tracking`
  (carrier, number), `event` (64-hex id), `order`. Proof is evidence; the requester judges it.

## Kind 422: Acceptance

- On a loop: `["e","<421-id>","<relay>","fulfillment"]` and `["e","<420-id>","<relay>","need"]` (both required), and
  exactly one `p` = the 421 author.
- `amount` (optional): total paid including tip, msat. `tip` (optional): portion of `amount`; requires `amount`; `tip ≤ amount`.
- `preimage` (64 hex), `zap` (id of a kind 9735), `cashu` (optional): **claimed** payment.
- `status` (optional): `accepted` (default) or `rejected`.
- A 422 with no `need` reference is a standalone review and MUST carry an `a` `31420:*` or `r` tag (see NIP-DRAFT.md).

## Validation

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

## Security considerations

- **Payment proof.** Payment fields are self-reported claims; nothing in this NIP verifies payment. The strongest evidence
  that a need was met is the 420 author's own signed 422. A preimage the payee minted for its own invoice, or a zap receipt signed by the payee's own LNURL
  service, proves nothing about a third party paying. Validators MUST treat these as claims. Upgrading a claim to
  verified requires keys bound to the payee independently of the event author (see NIP-DRAFT.md Reputation / proof tiers)
  and is out of scope here.
- **Sybils.** One operator with many keys can produce structurally perfect loops between its own keys. Only same-key
  self-fulfilment is detectable from the events. Cross-key collusion is a weighting problem for indexers, not a validity rule.
- **Tips** are display only and MUST NOT affect ranking or any mark.
- **Custody.** Indexers MUST NOT hold funds, keys, wallet connections or ecash on behalf of users.

## Kind collision check (CASCADE 1.1, 2026-11-01, read-only)

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
