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
| `multiple_acceptances` | 422 | more than one non-mismatched 422 cites the same 421 |

A loop (420→421→422) is reported only when the 422 is `accepted` and has none of `acceptor_not_requester`,
`need_mismatch`, `fulfiller_mismatch`.

## Security considerations

- **Payment proof.** A preimage the payee minted for its own invoice, or a zap receipt signed by the payee's own LNURL
  service, proves nothing about a third party paying. Validators MUST treat these as claims. Upgrading a claim to
  verified requires keys bound to the payee independently of the event author (see NIP-DRAFT.md Reputation / proof tiers)
  and is out of scope here.
- **Sybils.** One operator with many keys can produce structurally perfect loops between its own keys. Only same-key
  self-fulfilment is detectable from the events. Cross-key collusion is a weighting problem for indexers, not a validity rule.
- **Tips** are display only and MUST NOT affect ranking or any mark.
- **Custody.** Indexers MUST NOT hold funds, keys, wallet connections or ecash on behalf of users.
