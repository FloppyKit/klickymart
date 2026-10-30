# KlickyMart site (Cloudflare Worker)

Public map of where software agents can shop. This package is the Worker, static assets, agent API, MCP endpoint, and server-rendered pages.

## Local dev

```bash
cd site
npm ci --legacy-peer-deps
node scripts/embed-fixtures.js
npm run dev
```

Open http://127.0.0.1:8787. Fixtures (sample + synthetic) are embedded for local dev; production loads from D1/KV after ingest.

## Ingest

```bash
npm run ingest -- --file fixtures/records.sample.ndjson
npm run ingest -- --file fixtures/records.synthetic.ndjson --allow-synthetic
```

Production ingest uses D1 + KV (`--remote` prints a stub; Matt runs `scripts/deploy.sh`).

## Tests

```bash
npm test          # unit + integration (vitest pool workers)
npm run bench     # filter perf gate (p50 < 10ms @ 10k)
npm run e2e       # Playwright (start `npm run dev` first)
```

## Deploy (Matt only)

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… ./scripts/deploy.sh --dry-run
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… RECORDS=fixtures/records.sample.ndjson ./scripts/deploy.sh
```

Replace `REPLACE_AT_DEPLOY` in `wrangler.toml` with real D1 and KV IDs from the create commands.

## License

Site and Worker source: MIT (`LICENSE` at repo root). Published crawl records: CC0 1.0 (`DATA-LICENSE`).

**Preview data:** set `PREVIEW_DATA = "1"` in `wrangler.toml` (or the Worker env) to load synthetic `*.example` records only and show a **Preview data** badge in the header.

## Swapping file ingest for relay

Implement `RelaySource` in `worker/src/ingest.ts` and call `ingest(new RelaySource(...), env)` from deploy or cron. The `RecordSource` interface is shared with `NdjsonFileSource` and `ArrayRecordSource` (tests).

## Deploy note: facilitator key (2026-10-30)

`POST /facilitate` signs facilitated 421s with a key separate from the crawler key.
Public key: `npub1zw8a7v4eyagkd0eqpqle0c06xxnvyuwaps2hyk3xykqgfsa49h9srq3694` (hex `138fdf32b9275166bf20083f97e1fa31a6c271dd0c15725a26258084c3b52dcb`).
The secret lives only on the ops box (`nostr-market/secrets/facilitator.nsec`, mode 600, gitignored) and as the Worker secret
`FACILITATOR_SK_HEX` (`wrangler secret put FACILITATOR_SK_HEX --env production`, value piped from stdin, never echoed).
Without the secret, POST /facilitate returns 503 and signs nothing.
