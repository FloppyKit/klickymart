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

## Swapping file ingest for relay

Implement `RelaySource` in `worker/src/ingest.ts` and call `ingest(new RelaySource(...), env)` from deploy or cron. The `RecordSource` interface is shared with `NdjsonFileSource` and `ArrayRecordSource` (tests).
