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
4. Submit: POST ${origin}/reviews with the signed event as the JSON body (add ?dry_run=1 to validate without storing),
   or MCP tool submit_review {event}. You may also publish the same event to Nostr relays yourself.
Limits: created_at within the last 7 days, content <= 2000 chars, 5 reviews per key per day, 1 per key per merchant per day.
Reviews are signed claims, shown as such. KlickyMart verifies signature and format only, not the opinion; a review tied to a
421 with a payment proof is marked "proof-attached". We store no IP addresses.`;

export function buildLlmsTxt(origin: string, contact: string, relays: string[], aExample = "31420:<record-author-pubkey>:example.com"): string {
  return `# KlickyMart

> A public, signed map of which online stores software agents can reach, how far a guest checkout gets, which payment methods each store offers, and how privately it accepts Bitcoin. Every fact links to the public page it came from. No key, no login.

The crawler respects robots.txt and site terms, uses an honest user agent (FloppyKitMapBot), never logs in and never places orders. Sites that refuse agents are recorded as data. Unknown fields stay null; do not read null as "no".

## HTTP endpoints (GET, JSON unless noted)
- ${origin}/check?domain=example.com : "Can my agent shop here?" verdict for one domain: reachable | agents-not-welcome | blocked-tos | error | not-in-index, plus checkout depth, pay methods, BTC grade (0-4), record timestamp and an evidence URL. Index lookup only; it never starts a live crawl.
- ${origin}/q?q=&status=&pay=&pay_group=lightning&btc_min=3&reachable=1&limit=50 : search records (format=ndjson for NDJSON).
- ${origin}/records/{domain} : one full record.
- ${origin}/summary.json : counts and headline numbers.
- ${origin}/export.ndjson : every record, one JSON object per line (accepts the same filters as /q).
- ${origin}/.well-known/klickymart.json : machine-readable capabilities (endpoints, relays, licenses).
- ${origin}/openapi.json : OpenAPI 3.1 description.
- ${origin}/stats/agents.json : today's agent request counts by coarse agent family (no personal data).

## MCP
POST ${origin}/mcp : MCP over a minimal stateless Streamable HTTP transport. Send one JSON-RPC 2.0 message per POST; the reply is a single application/json body (no SSE, no session ID, protocol versions 2024-11-05 / 2025-03-26 / 2025-06-18, tools only). GET /mcp returns 405.
Tools:
- search_merchants {q?, status?, cat?, pay?, pay_group?, btc_min?, scope?, limit?<=100}
- get_record {domain}
- check_domain {domain} : same verdict as GET /check
- get_reviews {domain} : kind 422 reviews for a merchant
- submit_review {event, dry_run?} : submit a kind 422 review you signed locally
Install snippets: ${origin}/about#mcp

## Reviews (kind 422)
- GET ${origin}/reviews?domain=<d> : reviews for one merchant (also in /records/{d} and summarized in /check)
- POST ${origin}/reviews[?dry_run=1] : body = one signed kind 422 event
${REVIEW_GUIDE(origin, aExample)}

## Nostr records
Each site is one addressable Nostr event, kind ${NOSTR_KIND_CRAWL_RECORD}, d tag = canonical domain (newest per pubkey+d wins). Labels are NIP-32 tags ["l","<key>:<value>","${NIP_CRAWL_NAMESPACE}"]:
status (crawled | agents-not-welcome | blocked-tos | error), tos, pay / pay_online / pay_instore / pay_unscoped / no (payment codes such as card, lightning, btc-onchain, cashu, bnpl:<provider>), btc (0-4 privacy grade), btc_any, btcpriv (noacct, nokyc, selfhosted, ecash, sp, ark), ag (agent reach 0-3), co (checkout ease 0-3), guest, kyc, ar (restriction found), anw, cause; plus crawled_at, v, license, name, vantage, crawler.
Relays: ${relays.join(", ")}
Full tag table: ${origin}/docs/nostr-tags . Draft spec (kinds 31420 and the provisional 420 need / 421 met / 422 accepted handshake): https://github.com/FloppyKit/klickymart/blob/main/NIP-DRAFT.md

## Licenses
Code: MIT (https://github.com/FloppyKit/klickymart). Data: CC0-1.0 (${origin}/DATA-LICENSE).

## Contact
${contact} . Opt out: disallow FloppyKitMapBot in robots.txt. Bot info: ${origin}/bot
`;
}
