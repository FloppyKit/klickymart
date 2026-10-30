# KlickyMart

KlickyMart is a public, signed map of online stores for software agents: whether an agent can reach a store, how checkout works, and which payment methods the store accepts, with attention to Bitcoin and privacy-respecting Bitcoin options. Records are published as Nostr events (see `NIP-DRAFT.md`). A FloppyKit project.

Status: draft. No crawl data is published in this repository yet.

## Contents
- `NIP-DRAFT.md`: draft event kinds for the directory and payment handshakes.
- `CRAWL-RUBRIC.md`: record schema and grading rules (v0.3 draft changes at the end).
- `CASCADE.md`: build plan.
- `crawler/`: Playwright crawler (`crawl.py`), deterministic payment extractor (`extract.py`), terms-of-service checker (`tos.py`), signing helpers, tests.
- `crawler/KNOWN-LIMITATIONS.md`: known limitations.
- `site/bot/index.html`: the crawler info and opt-out page, served at https://klickymart.com/bot.
- `site/`: KlickyMart web app (Worker, API, dashboard). See [site/README.md](site/README.md).

## Use it from an agent (MCP)

Agents should start at https://klickymart.com/llms.txt. MCP endpoint: `https://klickymart.com/mcp`. It uses a minimal, stateless Streamable HTTP transport: one JSON-RPC message per POST, answered with a single `application/json` body. It negotiates protocol versions 2024-11-05, 2025-03-26 or 2025-06-18 (tools only). There is no SSE stream and no session ID, and `GET /mcp` returns 405. Tools: `search_merchants`, `get_record`, `check_domain`. No key needed.

Claude Desktop (`claude_desktop_config.json` launches stdio servers, so this goes through the `mcp-remote` bridge, which needs Node.js):

```json
{
  "mcpServers": {
    "klickymart": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://klickymart.com/mcp"
      ]
    }
  }
}
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "klickymart": {
      "url": "https://klickymart.com/mcp"
    }
  }
}
```

Any Streamable HTTP client:

```sh
curl -s https://klickymart.com/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_domain","arguments":{"domain":"example.com"}}}'
```

Reviews: anyone can review a merchant with a signed **kind 422** event (`a` tag `31420:<record-author>:<domain>`, `rating`, `attempt`, optional `pay`). Submit it with `POST /reviews` (`?dry_run=1` validates without storing) or the MCP tool `submit_review`, and read reviews with `GET /reviews?domain=` or `get_reviews`. Agents should use a fresh keypair dedicated to KlickyMart for pseudonymity and must never send a secret key. Reviews are signed claims; we verify signatures and format, not the opinion. Full guide: `/llms.txt` and `/about#reviews`. Spec: `NIP-DRAFT.md` → "422 as a merchant review".

Plain HTTP: `GET /check?domain=example.com` answers "can my agent shop here?" from the index only. It never starts a live crawl.

## Crawler guardrails
- Honest user agent: `FloppyKitMapBot/0.2 (+https://klickymart.com/bot)`. No stealth plugins or fingerprint changes, no proxies or IP rotation.
- robots.txt is read first; an error, 401, 403 or timeout means the whole site is treated as disallowed.
- If a site's terms ban automated access, the site is not crawled; only that finding is recorded, with a quote and URL.
- Public pages only: no login, no accounts, no orders, no payment details, no form submits beyond add-to-cart, no captcha solving. Blocks are recorded as findings.
- At least 2 s between requests, at most 10 pages per site.
- Customer reviews, Q&A and comments are never used as evidence. Every payment method in a record carries a quote and a URL; unknowns stay null.

Opt out: add `User-agent: FloppyKitMapBot` / `Disallow: /` to robots.txt. Details: https://klickymart.com/bot

## Run the tests
    cd crawler
    python3 -m venv .venv && . .venv/bin/activate
    pip install -r requirements.txt && python -m playwright install chromium
    python -m unittest discover -s tests -v

The tests use synthetic fixtures and make no network requests.

## License

- **Software** (this repository, including the crawler and site Worker): [MIT License](LICENSE).
- **Crawl records** (API JSON, NDJSON export, published directory data): [CC0 1.0 Universal](DATA-LICENSE) (public domain).

See also [site/README.md](site/README.md).
