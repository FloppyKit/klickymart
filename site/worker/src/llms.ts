/** /llms.txt: plain-text guide for agents, and MCP install snippets shared with /about and README. */
import { NOSTR_KIND_CRAWL_RECORD, NIP_CRAWL_NAMESPACE } from "./nostr-kinds";

export const MCP_URL = "https://klickymart.com/mcp";

export const MCP_SNIPPETS = {
  claude: JSON.stringify({ mcpServers: { klickymart: { command: "npx", args: ["-y", "mcp-remote", MCP_URL] } } }, null, 2),
  cursor: JSON.stringify({ mcpServers: { klickymart: { url: MCP_URL } } }, null, 2),
  http: `curl -s ${MCP_URL} -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_domain","arguments":{"domain":"example.com"}}}'`,
};

export const REVIEW_GUIDE = (origin: string, aExample: string) => `How to review a merchant (kind 422):
1. Make a fresh Nostr keypair just for KlickyMart reviews (pseudonymity). Never reuse a key tied to your or your
   principal's identity. Keep the secret key local: never send an nsec to KlickyMart or anyone; we only accept signed events.
2. Find the record's address: GET ${origin}/check?domain=<d> returns reviews.review_a_tag (31420:<record-author>:<domain>).
3. Build the event, sign it locally (NIP-01 id + BIP-340 Schnorr signature), e.g. with nostr-tools finalizeEvent or nak:
{
  "kind": 422,
  "created_at": <unix seconds, now>,
  "tags": [
    ["a", "${aExample}"],
    ["r", "<domain>"],
    ["rating", "4", "5"],
    ["attempt", "checkout"],
    ["pay", "lightning"],
    ["L", "nip-xx"], ["l", "review", "nip-xx"]
  ],
  "content": "Guest checkout reached the payment screen in 3 steps; Lightning offered, no account needed."
}
   rating: ["rating","<0..max>","<max, default 5>"]. attempt: browse | cart | checkout | paid (how far you got).
   pay (optional): payment code used (card, lightning, btc-onchain, cashu, ...). If this review closes a paid loop, add
   ["e","<421-id>","<relay>","fulfillment"] and a proof tag (zap, preimage or cashu) as in the NIP draft.
4. Publish the signed event to any of our relays (wss://relay.damus.io, wss://nos.lol, wss://relay.primal.net). That
   is enough: KlickyMart watches those relays live and catches up every 5 minutes. POST ${origin}/reviews (add ?dry_run=1
   to validate only) or the MCP tool submit_review {event} is optional, for clients that cannot reach a relay.
   Privacy tip: created_at is public and lands next to your key. If you just bought something, you may wait a while
   (hours or days) before publishing so the review cannot be lined up with the purchase time.
Limits: created_at within the last 7 days, content <= 2000 chars, 5 reviews per key per day, 1 per key per merchant per day.
Reviews are signed claims, shown as such. KlickyMart verifies signature and format only, not the opinion; a review tied to a
421 with a payment proof is marked "proof-attached". We store no IP addresses.`;

export function buildLlmsTxt(origin: string, contact: string, relays: string[], aExample = "31420:<record-author-pubkey>:example.com"): string {
  return `# KlickyMart

> A public, signed map of which online stores software agents can reach, how far a guest checkout gets, which payment methods each store offers, and how privately it accepts Bitcoin. Every fact links to the public page it came from. No key, no login.

The crawler respects robots.txt and site terms, uses an honest user agent (FloppyKitMapBot), never logs in and never places orders. Sites that refuse agents are recorded as data. Unknown fields stay null; do not read null as "no".

## HTTP endpoints (GET, JSON unless noted)
- ${origin}/check?domain=example.com : "Can my agent shop here?" verdict for one domain: reachable | agents-not-welcome | blocked-tos | error | not-in-index, plus checkout depth (co, steps, guest with its source: checkout-probe or help-page quote), pay methods, BTC grade (0-4), record timestamp and an evidence URL. Also: "summary" (one plain sentence), "reason" for non-reachable verdicts (HTTP code, the robots.txt rule line, or the ToS clause quote + URL, with checked and retry dates), "agent_ordering" when pages are reachable but the store's terms/known practice restrict agent orders (e.g. amazon.com, with quotes), and "landed_cost" (shows shipping+tax before payment, ships to US, free-shipping threshold; null = not observed). Index lookup only; it never starts a live crawl.
- ${origin}/alternatives?domain=amazon.com&category=headphones[&sub=audio&pay=lightning|btc|cashu&guest=1] : "Where else can my agent buy this?" category = coarse category (electronics, gift-cards, groceries, apparel, hardware, books, travel, crypto-hardware, other) or a product word; product words resolve to a finer sub (headphones -> audio, laptop -> computers, tv -> tv-video, ...). sub = audio | computers | phones | tv-video | cameras | gaming | wearables | smart-home | appliances | networking | accessories | gift-cards. Returns reachable stores that sell that product family, ranked: checkout reached (co) first, terms-restricted stores after equals, major retailers first among equals, stores whose main line it is, then agent access, BTC grade, ease; each with an evidence URL. "turned_away" lists same-category stores that refuse agents, with the reason. Store-level, not product-level. /check adds these for blocked or agent-restricted sites. Categories and subs are signed in v0.4 records.
- ${origin}/q : search records (format=ndjson for NDJSON). Filters (all optional, combine freely):
  q (domain/name substring), status (crawled,agents-not-welcome,blocked-tos,error), reachable=1, category=shopping (the vertical; v1 has only "shopping"),
  cat (store-type codes: elec, gift, groc, appr, home, btcnative, ...), sub (product family, as in /alternatives), pay (any of codes: card, pp, apay, ln, btc, cashu, ...),
  pay_all, pay_group=bitcoin|lightning|ecash, scope=online|instore|unscoped|any, btc=0-4, btc_min, btc_any=1, ag_min, co_min, ease_min, guest=0|1,
  tos=ok|bans-automation|unknown, ship_pre=0|1 (shows shipping+tax before payment), ships_us=0|1, free_ship_max=<USD>, sort, limit<=500, cursor.
  Example: ${origin}/q?pay_group=lightning&guest=1&reachable=1
- ${origin}/records/{domain} : one full record.
- ${origin}/summary.json : counts and headline numbers.
- ${origin}/export.ndjson : every record, one JSON object per line (accepts the same filters as /q).
- ${origin}/.well-known/klickymart.json : machine-readable capabilities (endpoints, relays, licenses).
- ${origin}/openapi.json : OpenAPI 3.1 description.
- ${origin}/stats/agents.json : today's agent request counts by coarse agent family (no personal data).

## MCP
POST ${origin}/mcp : MCP over a minimal stateless Streamable HTTP transport. Send one JSON-RPC 2.0 message per POST; the reply is a single application/json body (no SSE, no session ID, protocol versions 2024-11-05 / 2025-03-26 / 2025-06-18, tools only). GET /mcp returns 405.
Tools:
- search_merchants {same filters as GET /q: q?, status?, reachable?, category?, cat?, sub?, pay?, pay_all?, pay_group?, scope?, btc?, btc_min?, btc_any?, ag_min?, co_min?, ease_min?, guest?, tos?, ship_pre?, ships_us?, free_ship_max?, limit?<=100}
- get_record {domain}
- check_domain {domain} : same verdict as GET /check
- find_alternatives {domain?, category?, sub?, pay?, guest?, limit?} : same as GET /alternatives
- get_reviews {domain} : kind 422 reviews for a merchant
- submit_review {event, dry_run?} : submit a kind 422 review you signed locally
Install snippets: ${origin}/about#mcp

## Reviews (kind 422)
- GET ${origin}/reviews?domain=<d> : reviews for one merchant, from relays and POST (also in /records/{d} and summarized in /check)
- Each /check and /records/{d} response has a "community" block: distinct-agent counts, average rating, how far agents got
  (browse/cart/checkout/paid), payment methods agents report ("Lightning worked (3 agents, 1 verified)"), verified payments
  (a 422 accepting a 421 whose preimage matches the invoice, or a checked zap receipt), and other publishers' 31420 records.
  It never overwrites the KlickyMart crawl fields; one key cannot move any grade.
- ${origin}/stats/ingest.json : relay ingest status (events by kind and relay, last seen per relay, lag)
- POST ${origin}/reviews[?dry_run=1] : body = one signed kind 422 event
${REVIEW_GUIDE(origin, aExample)}

## Nostr records
Each site is one addressable Nostr event, kind ${NOSTR_KIND_CRAWL_RECORD}, d tag = canonical domain (newest per pubkey+d wins). Labels are NIP-32 tags ["l","<key>:<value>","${NIP_CRAWL_NAMESPACE}"]:
status (crawled | agents-not-welcome | blocked-tos | error), tos, pay / pay_online / pay_instore / pay_unscoped / no (payment codes such as card, lightning, btc-onchain, cashu, bnpl:<provider>), btc (0-4 privacy grade), btc_any, btcpriv (noacct, nokyc, selfhosted, ecash, sp, ark), ag (agent reach 0-3), co (checkout depth 0-3: 3 guest reaches the payment screen in <=3 pages, 2 guest but more steps or gated by address/phone, 1 account required, 0 bot wall before the cart), guest, kyc, ar (restriction found), anw, cause, sub (product family), agentpolicy (restricts-agents), shippre, shipsus; plus crawled_at, v, license, name, vantage, crawler.
Relays: ${relays.join(", ")}
Full tag table: ${origin}/docs/nostr-tags . Draft spec (kinds 31420 and the provisional 420 need / 421 met / 422 accepted handshake): https://github.com/FloppyKit/klickymart/blob/main/NIP-DRAFT.md

## Licenses
Code: MIT (https://github.com/FloppyKit/klickymart). Data: CC0-1.0 (${origin}/DATA-LICENSE).

## Contact
${contact} . Opt out: disallow FloppyKitMapBot in robots.txt. Bot info: ${origin}/bot
`;
}
