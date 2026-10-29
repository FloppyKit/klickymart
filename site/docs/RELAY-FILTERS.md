# Relay REQ filters (kind 31420)

KlickyMart crawl records are **Nostr kind 31420** events. Filterable facts are duplicated as NIP-32 **`l`** tags with shape `key:value` and label namespace **`L` = `nip-xx`** (placeholder until the crawl NIP is assigned).

Replace `nip-xx` with the namespace from [`nostr-kinds.ts`](../worker/src/nostr-kinds.ts) when it changes.

## Minimal REQ skeleton

```json
{
  "kinds": [31420],
  "#L": ["nip-xx"],
  "#t": ["shopping"]
}
```

Add **`#l`** filters for each fact you care about (all values are lowercase).

## Recipes by `#l` label

| Goal | `#l` filter |
|------|-------------|
| Reachable merchants | `status:crawled` |
| Blocked by ToS | `status:blocked-tos` |
| Agents not welcome | `status:agents-not-welcome` |
| Crawl error | `status:error` |
| ToS allows automation | `tos:ok` |
| ToS bans automation | `tos:bans-automation` |
| Agent access ≥ 2 | `ag:2` (also try `ag:3`) |
| BTC privacy grade 3 | `btc:3` |
| Accepts Lightning (tag) | `pay:ln` |
| Accepts on-chain BTC (tag) | `pay:btc` |
| Guest checkout | `guest:1` |

### Example: Lightning + guest + BTC grade 2

```json
{
  "kinds": [31420],
  "#L": ["nip-xx"],
  "#l": ["status:crawled", "pay:ln", "guest:1", "btc:2"]
}
```

### Example: Bitcoin-accepting (any pay tag)

Use several REQ subscriptions or a single relay that supports OR semantics; most relays treat multiple `#l` as AND:

```json
{
  "kinds": [31420],
  "#L": ["nip-xx"],
  "#l": ["status:crawled", "pay:btc"]
}
```

Also subscribe with `"#l": ["pay:ln"]` and merge client-side.

## Author key

Only events signed by the KlickyMart crawler should be trusted for the official map:

- **NIP-05:** `bot@klickymart.com` → see `/.well-known/nostr.json`
- **npub:** listed in `/.well-known/klickymart.json` under `crawler.npub`

## HTTP mirror

Same filters exist on **`GET /q`** (JSON and HTML). Example:

`/q?btc=2&guest=1&pay=lightning`

See [`/docs/api`](/docs/api) and [`/openapi.json`](/openapi.json).
