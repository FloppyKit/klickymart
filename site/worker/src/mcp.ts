import { AN_ALT_CATEGORIES, AN_CATS } from "./agent-native";
import { WALLET_GUIDE } from "./wallet";
import { CONDITION_FILTERS, PRODUCT_TYPES } from "./product-quality";
import { flagPrefix } from "./row-flags";
import { Q_BOOL_FILTERS, Q_CATEGORIES, STATUS_VALUES, CAT_CODES, SUBCATEGORIES, PAY_CODES, PAY_ALIASES, PAY_GROUP_NAMES, ALT_PAY_FILTERS, BLOCKER_KINDS } from "./vocab";
import type { QueryParams } from "./query";
import { validateQueryParams } from "./query";

export function buildOpenApi(origin: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "KlickyMart Agent API",
      version: "0.5",
      description: "Query the signed map of where agents can shop.",
    },
    servers: [{ url: origin }],
    paths: {
      "/q": {
        get: {
          summary: "Search merchant records",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "category", in: "query", schema: { type: "string", enum: Q_CATEGORIES } },
            { name: "cat", in: "query", schema: { type: "string" } },
            ...Q_BOOL_FILTERS.map((n) => ({ name: n, in: "query", schema: { type: "string", enum: ["0", "1"] } })),
            { name: "pay", in: "query", schema: { type: "string" } },
            { name: "agent_native", in: "query", schema: { type: "string", enum: ["0", "1"] }, description: "1 = agent-native stores only (L402/x402 paid APIs, VPN, eSIM, VPS, gift cards, nostr-native, agent-commerce)" },
            { name: "an_cat", in: "query", schema: { type: "string", enum: [...AN_CATS, ...Object.keys(AN_ALT_CATEGORIES)] }, description: "agent-native category (vps, vpn, esim, paid-api, gift-cards, or a raw an_cat)" },
            { name: "rail_status", in: "query", schema: { type: "string", enum: ["verified-402", "claimed"] }, description: "verified-402 = our one unauthenticated request got a real HTTP 402 challenge (never paid); claimed = listed by a directory only" },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 500 } },
            { name: "min_trust", in: "query", schema: { type: "string", enum: ["flagged", "unverified", "seen", "verified"] }, description: "Minimum trust_tier (every item carries trust_tier, trust_label, trust_why, src)" },
          ],
          responses: {
            "200": {
              description: "Query results",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["version", "total", "count", "items", "filter_ms"],
                    properties: {
                      version: { type: "string" },
                      total: { type: "integer" },
                      count: { type: "integer" },
                      next: { type: ["string", "null"] },
                      filter_ms: { type: "number" },
                      items: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "400": { description: "Bad parameter" },
          },
        },
      },
      "/records/{domain}": {
        get: {
          summary: "Get one record",
          parameters: [{ name: "domain", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Record payload" },
            "404": { description: "Not found" },
          },
        },
      },
      "/export.ndjson": { get: { summary: "NDJSON export", responses: { "200": { description: "NDJSON stream" } } } },
      "/stats": { get: { summary: "Aggregate stats", responses: { "200": { description: "Stats JSON" } } } },
      "/check": { get: { summary: "One store (domain=) or up to 10 (domains=a,b,c): pay, checkout map, policies, trust, landed-cost parts for a ZIP", description: "Top-level co/checkout, guest, agent_access and btc/btc_grade come from the same row as /alternatives. checkout_map.first_blocker.kind is one of: " + BLOCKER_KINDS.join(", ") + ".", parameters: [{ name: "domains", in: "query", schema: { type: "string" }, description: "batch: 1-10 comma-separated domains" }, { name: "domain", in: "query", required: true, schema: { type: "string" }, description: "Store hostname" }, { name: "zip", in: "query", required: false, schema: { type: "string" }, description: "5-digit US ZIP for landed-cost parts" }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/alternatives": { get: { summary: "Where else can my agent buy this? Ranked stores in a coarse category", parameters: [{ name: "domain", in: "query", required: false, schema: { type: "string" }, description: "Store you were blocked at" }, { name: "category", in: "query", required: false, schema: { type: "string" }, description: "Coarse category or product word (headphones, gift card); agent-native categories: vps, vpn, esim, paid-api, gift-cards" }, { name: "sub", in: "query", required: false, schema: { type: "string" }, description: "Product family" }, { name: "pay", in: "query", required: false, schema: { type: "string" }, description: "lightning | btc | cashu" }, { name: "guest", in: "query", required: false, schema: { type: "string" }, description: "1 = guest checkout confirmed" }, { name: "zip", in: "query", required: false, schema: { type: "string" }, description: "5-digit US ZIP" }, { name: "taxpre", in: "query", required: false, schema: { type: "string" }, description: "1 = only stores observed to show tax before payment (with zip)" }, { name: "limit", in: "query", required: false, schema: { type: "integer" }, description: "Max items" }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/offers": { get: { summary: "Product offers observed on store pages (JSON-LD / Shopify JSON); live=1 adds live Shopify Catalog results (never stored)", parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" }, description: "Product words; synonyms like ANC / noise-cancelling / over-ear are expanded" }, { name: "gtin", in: "query", required: false, schema: { type: "string" }, description: "GTIN/UPC/EAN" }, { name: "mpn", in: "query", required: false, schema: { type: "string" }, description: "Manufacturer part number" }, { name: "domain", in: "query", required: false, schema: { type: "string" }, description: "Limit to one store" }, { name: "zip", in: "query", required: false, schema: { type: "string" }, description: "5-digit US ZIP for landed cost" }, { name: "in_stock", in: "query", required: false, schema: { type: "string" }, description: "1 = in stock only" }, { name: "max_price", in: "query", required: false, schema: { type: "number" }, description: "USD" }, { name: "live", in: "query", required: false, schema: { type: "string" }, description: "1 = add live Shopify Catalog results" }, { name: "limit", in: "query", required: false, schema: { type: "integer" }, description: "Max items" }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/recheck": { get: { summary: "Re-read robots.txt and home status for an indexed store now (rate-limited)", parameters: [{ name: "domain", in: "query", required: true, schema: { type: "string" }, description: "Indexed store hostname" }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } }, post: { summary: "Same as GET", parameters: [{ name: "domain", in: "query", required: true, schema: { type: "string" }, description: "Indexed store hostname" }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/facilitate": { get: { summary: "Facilitator npub, limits and usage. While facilitation is paused this returns 503 facilitation_paused", responses: { "200": { description: "JSON (facilitation enabled)" }, "503": { description: "facilitation_paused: facilitation is switched off; nothing is signed" } } }, post: { summary: "PAUSED (returns 503 facilitation_paused). Get a kind 421 signed by KlickyMart as FACILITATOR (not the store) after a payment-proof check; returned unpublished", responses: { "200": { description: "signed event" }, "400": { description: "bad proof/param" }, "409": { description: "store claimed its listing" }, "429": { description: "rate limited" }, "503": { description: "facilitation_paused, or not configured" } } } },
      "/wallet": { get: { summary: "Non-custodial wallet setup page", responses: { "200": { description: "HTML" } } } },
      "/app": { get: { summary: "Nostr-app login (NIP-07, NIP-46, local nsec in the browser) and filtered feeds; strict CSP", responses: { "200": { description: "HTML" } } } },
      "/auth/challenge": { get: { summary: "One-time login challenge (sign a kind 27235 event with u, method, challenge tags)", responses: { "200": { description: "JSON" }, "503": { description: "login not configured" } } } },
      "/auth/login": { post: { summary: "POST {event: signed kind 27235}. Verifies the signature and one-time challenge; sets an HttpOnly session cookie. Never send a key.", responses: { "200": { description: "JSON" }, "400": { description: "bad event or used challenge" }, "403": { description: "cross-origin" }, "429": { description: "rate limited" } } } },
      "/auth/me": { get: { summary: "Pubkey of the current session, or null", responses: { "200": { description: "JSON" } } } },
      "/auth/logout": { post: { summary: "Clear the session cookie", responses: { "200": { description: "JSON" } } } },
      "/feed.json": { get: { summary: "Signature-verified events from the KlickyMart index. Filters: kind (31420,420,421,422,1), store, tag, author (hex), limit, until. Kind 1 requires #klickymart.", responses: { "200": { description: "JSON" }, "400": { description: "bad filter" } } } },
      "/feed/list-check": { post: { summary: "Verify a user-signed NIP-51 kind 30015 feed list (d = klickymart-feed:<name>). Nothing is stored or published.", responses: { "200": { description: "JSON" }, "400": { description: "invalid list" }, "429": { description: "rate limited" } } } },
      "/tip-ready.json": { get: { summary: "tip-ready badges for up to 50 pubkeys (kind 0 lud16/lud06 answers a LUD-06 payRequest). Display only, ranking_weight always 0.", responses: { "200": { description: "JSON" }, "400": { description: "bad pubkeys" } } } },
      "/tip/invoice": { post: { summary: "Get a bolt11 for a tip. Body {zap_request: signed kind 9734} for a NIP-57 zap, or {recipient|lud16, amount_msat, comment?} for a plain tip. The Worker fetches only the public LNURL-pay endpoint (https, public DNS, rebinding re-check) and checks the invoice amount and description_hash. Never send keys, NWC strings or Cashu tokens.", responses: { "200": { description: "JSON {pr, amount_msat, zapper_pubkey}" }, "400": { description: "bad input" }, "404": { description: "no Lightning address" }, "429": { description: "rate limited" }, "502": { description: "recipient wallet error" } } } },
      "/tip/receipt": { get: { summary: "Find the kind 9735 receipt for a zap request id in the index (?zap_request=&zapper=)", responses: { "200": { description: "JSON {found, receipt, sats, validated}" } } } },
      "/tip/nutzaps.json": { get: { summary: "NIP-61 nutzaps (kind 9321) on up to 100 event ids (?e=). Display only, never ranking weight.", responses: { "200": { description: "JSON" } } } },
      "/.well-known/lnurlp/zap": { get: { summary: "LUD-06 payRequest for zap@klickymart.com, re-served from the upstream address in LNURL_FORWARD_ZAP (metadata verbatim, allowsNostr/nostrPubkey passed through, callback on this origin). KlickyMart holds no funds. Unknown names 404.", responses: { "200": { description: "LUD-06 JSON" }, "404": { description: "unknown name or not configured" }, "429": { description: "rate limited" }, "502": { description: "upstream unavailable" } } } },
      "/.well-known/lnurlp/zap/callback": { get: { summary: "LUD-06 callback (?amount=msat[&nostr=<9734>][&comment=]). Forwards to the upstream callback; returns its bolt11 only if the amount and description_hash check out.", responses: { "200": { description: "{pr, routes}" }, "400": { description: "bad input" }, "502": { description: "upstream error" } } } },
      "/wallet.json": { get: { summary: "Wallet setup guide and checklist (JSON)", responses: { "200": { description: "JSON" } } } },
      "/flags.json": { get: { summary: "Flagged agent notes with explainable reasons", parameters: [{ name: "domain", in: "query", required: false, schema: { type: "string" } }], responses: { "200": { description: "JSON" } } } },
      "/flag": { post: { summary: "Submit a signed NIP-56 kind 1984 report about a note (not published)", responses: { "201": { description: "stored" }, "400": { description: "bad report" }, "429": { description: "rate limited" } } } },
      "/tips.json": { get: { summary: "NIP-57 tips on agent notes, per review and per reviewer", parameters: [{ name: "domain", in: "query", required: false, schema: { type: "string" } }], responses: { "200": { description: "JSON" } } } },
      "/curators.json": { get: { summary: "Curator record: who tipped which agent notes", responses: { "200": { description: "JSON" } } } },
      "/submit": { post: { summary: "Suggest a store (community submission, Path 3). Only domain, category hint, note and same-site evidence_url are accepted; facts come from the gated crawl.", parameters: [{ name: "dry_run", in: "query", required: false, schema: { type: "string", enum: ["1"] }, description: "1 = validate only, store nothing" }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { domain: { type: "string" }, category: { type: "string" }, note: { type: "string", maxLength: 280 }, evidence_url: { type: "string" }, submitter: { type: "object", properties: { agent_name: { type: "string" } } }, event: { type: "object", description: "signed kind 1423 store suggestion" } } } } } }, responses: { "200": { description: "duplicate, rejected-by-blocklist, or dry run: {id, domain, status, reason, trust_tier, flags}" }, "201": { description: "queued" }, "400": { description: "bad domain or event" }, "429": { description: "rate limited (10/day, 50/week per submitter and per salted network hash)" } } }, get: { summary: "How to submit, tiers and trust rules", responses: { "200": { description: "JSON" } } } },
      "/submit/queue/{id}/status": { post: { summary: "Box crawler reports the gated-crawl outcome (Authorization: Bearer INGEST_TOKEN)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "dry_run", in: "query", schema: { type: "string", enum: ["1"] } }], requestBody: { content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["crawled", "refused", "error"] }, reason: { type: "string", maxLength: 300 } } } } } }, responses: { "200": { description: "updated" }, "401": { description: "unauthorized" }, "404": { description: "unknown id or disabled" } } } },
      "/claim/dns": { post: { summary: "DNS TXT store claim or revocation: {event} = kind 1423 signed by the npub in the _klickymart.<domain> TXT, tags [[\"r\",domain],[\"claim\",\"dns\"|\"revoke\"]]; {domain} = re-check TXT (gone -> dns-removed)", parameters: [{ name: "dry_run", in: "query", schema: { type: "string", enum: ["1"] } }], responses: { "200": { description: "revoked / re-checked / dry run" }, "201": { description: "claim active" }, "422": { description: "TXT does not name the key" } } }, get: { summary: "Claim instructions, or ?domain= claim status", parameters: [{ name: "domain", in: "query", schema: { type: "string" } }], responses: { "200": { description: "JSON" } } } },
      "/submit/queue.ndjson": { get: { summary: "Same queue as /submit/queue.json, one JSON object per line", responses: { "200": { description: "NDJSON" } } } },
      "/submit/{id}": { get: { summary: "Submission status with crawl state and trust_tier", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "JSON" }, "404": { description: "not found" } } } },
      "/submit/queue.json": { get: { summary: "Public gated-crawl queue of community-submitted domains (read by the box crawler)", parameters: [{ name: "state", in: "query", schema: { type: "string", enum: ["pending", "review", "crawled", "refused"] } }, { name: "since", in: "query", schema: { type: "integer" } }, { name: "limit", in: "query", schema: { type: "integer", maximum: 2000 } }], responses: { "200": { description: "JSON (also /submit/queue.ndjson)" } } } },
      "/reviews": { get: { summary: "Agent reviews for a store", parameters: [{ name: "domain", in: "query", required: true, schema: { type: "string" }, description: "Store hostname" }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/summary.json": { get: { summary: "Counts by status and BTC grade", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/stats/agents.json": { get: { summary: "Agent visit stats", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/stats/ingest.json": { get: { summary: "Relay ingest stats", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/landed": { get: { summary: "One call: landed price of a product at a ZIP (indexed offers + live Shopify Catalog with live=1), store facts on every row; est_total only when price, shipping and tax are all known", parameters: [{ name: "zip", in: "query", required: true, schema: { type: "string" } }, ...["q", "gtin", "mpn", "url", "domain"].map((n) => ({ name: n, in: "query", schema: { type: "string" } })), { name: "max_price", in: "query", schema: { type: "number" } }, { name: "in_stock", in: "query", schema: { type: "boolean" } }, { name: "live", in: "query", schema: { type: "string", enum: ["1"] } }, { name: "condition", in: "query", schema: { type: "string", enum: [...CONDITION_FILTERS] } }, { name: "type", in: "query", schema: { type: "string", enum: [...PRODUCT_TYPES] } }, { name: "brand_strict", in: "query", schema: { type: "string", enum: ["1"] } }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/chart.json": { get: { summary: "Store chart: ranked on community shopping-experience notes (Nostr kind 422, 2+ keys) with crawl fallback; every value labelled with its source", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }, { name: "category", in: "query", schema: { type: "string" } }], responses: { "200": { description: "JSON" } } } },
      "/chart": { get: { summary: "Store chart (HTML)", responses: { "200": { description: "HTML" } } } },
      "/report": { get: { summary: "How to post a shopping-experience note (HTML)", responses: { "200": { description: "HTML" } } } },
      "/report/template": { get: { summary: "Unsigned kind 422 shopping-experience template (never signed or published by KlickyMart)", parameters: [{ name: "domain", in: "query", required: true, schema: { type: "string" } }, { name: "depth", in: "query", required: true, schema: { type: "string" } }, { name: "estimated", in: "query", required: false, schema: { type: "string" }, description: "true | false | comma list of amount kinds (price,price_seen,price_paid,fee,shipping,tax,total)" }, { name: "fee", in: "query", required: false, schema: { type: "string" }, description: "non-negative number, or unknown / not-observed (same for price, shipping, tax, total)" }], responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/pending.json": { get: { summary: "Queue of store domains from live results awaiting KlickyBot's robots -> terms -> public-pages check", responses: { "200": { description: "JSON" } } } },
      "/mcp": { post: { summary: "MCP (JSON-RPC 2.0, streamable HTTP): tools/list, tools/call", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/claim": { get: { summary: "Merchant claim page", responses: { "200": { description: "HTML or text" } } }, post: { summary: "Merchant claim submit", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/contribute": { get: { summary: "How to contribute observations", responses: { "200": { description: "HTML or text" } } } },
      "/_admin/revoke-facilitated": { post: { summary: "Admin: revoke facilitator-signed 421s and demote notes citing them (bearer token; 404 when disabled)", responses: { "200": { description: "JSON {ids, revoked, demoted} or {dry_run, would_revoke}" }, "401": { description: "unauthorized" }, "404": { description: "disabled" } } } },
      "/_ingest": { post: { summary: "Internal relay ingest trigger (authenticated)", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/merchant/{domain}": { get: { summary: "Merchant page (HTML)", parameters: [{ name: "domain", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "HTML or text" } } } },
      "/llms.txt": { get: { summary: "Agent guide", responses: { "200": { description: "HTML or text" } } } },
      "/llms-full.txt": { get: { summary: "Full agent guide", responses: { "200": { description: "HTML or text" } } } },
      "/openapi.json": { get: { summary: "This document", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/robots.txt": { get: { summary: "robots.txt", responses: { "200": { description: "HTML or text" } } } },
      "/sitemap.xml": { get: { summary: "Sitemap", responses: { "200": { description: "HTML or text" } } } },
      "/.well-known/ucp": { get: { summary: "UCP agent profile", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/ucp/agent-profile.json": { get: { summary: "UCP agent profile (alias)", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/.well-known/klickymart.json": { get: { summary: "Discovery document", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/.well-known/mcp.json": { get: { summary: "MCP discovery", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/.well-known/nostr.json": { get: { summary: "NIP-05", responses: { "200": { description: "JSON" }, "400": { description: "bad_param error" } } } },
      "/": { get: { summary: "Home (HTML)", responses: { "200": { description: "HTML or text" } } } },
      "/about": { get: { summary: "About and data credits (HTML)", responses: { "200": { description: "HTML or text" } } } },
      "/dashboard": { get: { summary: "Dashboard (HTML)", responses: { "200": { description: "HTML or text" } } } },
      "/docs/api": { get: { summary: "API docs (HTML)", responses: { "200": { description: "HTML or text" } } } },
      "/docs/nostr-tags": { get: { summary: "Nostr tag docs (HTML)", responses: { "200": { description: "HTML or text" } } } },
      "/docs/relay-filters": { get: { summary: "Relay filter docs (HTML)", responses: { "200": { description: "HTML or text" } } } },
    },
  };
}

export function queryParamsToMcpArgs(args: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) sp.set(k, v.join(","));
    else if (typeof v === "boolean") sp.set(k, v ? "1" : "0"); // /q booleans are 0|1
    else sp.set(k, String(v));
  }
  return sp;
}

export function mcpToolsList(opts: { facilitate?: boolean } = {}): unknown {
  const all = {
    tools: [
      {
        name: "search_merchants",
        description: "Search KlickyMart merchant records (same filters as GET /q)",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string", description: "substring of domain or store name" },
            status: { type: "array", items: { type: "string", enum: [...STATUS_VALUES] } },
            min_trust: { type: "string", enum: ["flagged", "unverified", "seen", "verified"], description: "Minimum trust_tier; applied before paging so total is exact. Items carry trust_tier, trust_proofs, trust_label, trust_why, src" },
            reachable: { type: "boolean", description: "status crawled and agent access >= 1" },
            category: { type: "string", enum: Q_CATEGORIES, description: "shopping (the vertical) or a coarse product category" },
            cat: { type: "array", items: { type: "string", enum: [...CAT_CODES] }, description: "Fine store-type codes" },
            sub: { type: "string", enum: [...SUBCATEGORIES], description: "Product family the store sells" },
            btc: { type: "integer", description: "exact BTC grade 0-4" },
            btc_min: { type: "integer" },
            btc_any: { type: "boolean" },
            pay: { type: "array", items: { type: "string", enum: [...PAY_CODES, ...Object.keys(PAY_ALIASES), ...PAY_GROUP_NAMES] }, description: "any of these method codes; aliases (btc-onchain, lightning, shop-pay...) are accepted; a single group name (bitcoin, lightning, ecash) works too" },
            pay_all: { type: "array", items: { type: "string" } },
            pay_group: { type: "string", enum: PAY_GROUP_NAMES },
            scope: { type: "string", enum: ["online", "instore", "unscoped", "any"] },
            ag_min: { type: "integer" }, co_min: { type: "integer" }, ease_min: { type: "integer" },
            guest: { type: "integer", enum: [0, 1] },
            tos: { type: "string", enum: ["ok", "bans-automation", "unknown"] },
            btc_indirect: { type: "integer", enum: [0, 1], description: "1 = stores where bitcoin works only indirectly (third-party processor such as BitPay/Confirmo/Coinbase Commerce/OpenNode, or a gift card bought with BTC); not native acceptance" },
            ship_pre: { type: "integer", enum: [0, 1], description: "1 = shows shipping and tax before the payment step (observed by the probe)" },
            ships_us: { type: "integer", enum: [0, 1] },
            free_ship_max: { type: "number", description: "free-shipping threshold at or below this many USD (publicly stated)" },
            agent_native: { type: "integer", enum: [0, 1], description: "1 = agent-native stores only" },
            an_cat: { type: "string", enum: [...AN_CATS, ...Object.keys(AN_ALT_CATEGORIES)] },
            rail_status: { type: "string", enum: ["verified-402", "claimed"] },
            limit: { type: "integer", maximum: 100 },
          },
        },
      },
      {
        name: "get_record",
        description: "Fetch one merchant record by domain",
        inputSchema: {
          type: "object",
          required: ["domain"],
          properties: { domain: { type: "string" } },
        },
      },
      {
        name: "check_domain",
        description: "Can my agent shop here? Verdict for one domain from the index (reachable, checkout-blocked, agents-not-welcome, blocked-tos, error, not-in-index; see verdict_reason and primary_reason), with checkout depth, pay methods, BTC grade, record time and evidence URL. Never triggers a live crawl.",
        inputSchema: {
          type: "object",
          required: ["domain"],
          properties: { domain: { type: "string", description: "Hostname, e.g. example.com" }, zip: { type: "string", description: "5-digit US ZIP: adds landed-cost estimate (tax estimate by state, shipping signals)" } },
        },
      },
      {
        name: "find_offers",
        description: "Product-level offers KlickyBot observed on store pages (schema.org JSON-LD or Shopify JSON): price, currency, stock, URL, checked_at. Match by gtin (UPC/EAN), mpn, or name words (q). Optional zip adds a landed-cost estimate; live=true also returns a live (uncached) Shopify Catalog search for q.",
        inputSchema: { type: "object", properties: { gtin: { type: "string" }, mpn: { type: "string" }, q: { type: "string" }, domain: { type: "string" }, zip: { type: "string" }, in_stock: { type: "boolean" }, max_price: { type: "number" }, live: { type: "boolean" }, limit: { type: "integer", maximum: 100 } } },
      },
      {
        name: "get_landed_price",
        description: "One call: a product's landed price at a US ZIP. Searches KlickyMart-observed offers (and, with live=true, the live Shopify Catalog, never stored), and returns for every product: price, stock, url, checked_at, shipping (with source), est. tax with the rate used, est_total ONLY when price+shipping+tax are all known, plus store facts (pay methods incl. Shop Pay/Link/BTC, guest checkout, checkout depth, first blocker). Products from stores KlickyMart has not indexed say 'store not indexed'.",
        inputSchema: { type: "object", required: ["zip"], properties: { zip: { type: "string", description: "5-digit US ZIP" }, q: { type: "string" }, gtin: { type: "string" }, mpn: { type: "string" }, url: { type: "string", description: "a product URL to price" }, domain: { type: "string" }, in_stock: { type: "boolean" }, max_price: { type: "number" }, live: { type: "boolean" }, condition: { type: "string", enum: [...CONDITION_FILTERS] }, type: { type: "string", enum: [...PRODUCT_TYPES] }, brand_strict: { type: "boolean" }, limit: { type: "integer", maximum: 50 } } },
      },
      {
        name: "build_experience_note",
        description: "Returns an UNSIGNED Nostr kind 422 'shopping experience' event template for a store, for you to sign with your own (ideally site-specific) key and publish to your own relays. KlickyMart never signs or publishes for you. Optionally POST the signed event to /reviews (or the submit_review tool). Location must be ZIP3, US state (US-KS) or country only. Proof tags (zap/preimage/cashu/order_hash = sha256 of the confirmation) mark a verified purchase.",
        inputSchema: { type: "object", required: ["domain", "depth"], properties: { domain: { type: "string" }, depth: { type: "string", enum: ["browse", "product", "cart", "checkout", "shipping", "payment", "paid", "delivered"], description: "furthest stage reached (same stages as checkout maps; 'attempt' accepted as an alias)" }, basis: { type: "string", enum: ["visit", "directory", "secondhand", "unknown"], description: "visit = you went to the store; directory = written from KlickyMart data; secondhand = relayed; omitted = unknown. Only visit counts toward the chart." }, product: { type: "string", description: "product URL or GTIN" }, guest: { type: "string", enum: ["true", "false", "unknown", "yes", "no"], description: "yes/no are aliases for true/false" }, account_required: { type: "string", enum: ["true", "false", "unknown", "yes", "no"] }, shown_before_payment: { type: "string", description: "comma list: tax, shipping, none, not-observed or unknown" }, blocker: { type: "string" }, walls: { type: "array", items: { type: "string" } }, pay_used: { type: "string", description: "vocab pay code (see /vocab.json), e.g. ln, btc, card, spay" }, pay_offered: { type: "array", items: { type: "string" }, description: "vocab codes; an empty list means you looked and saw none (tagged none-observed); omit if not checked" }, btc_route: { type: "string", enum: ["native", "indirect", "lightning"] }, tax_shown_before_payment: { type: "string", enum: ["true", "false", "unknown", "not-observed"] }, shipping_shown_before_payment: { type: "string", enum: ["true", "false", "unknown", "not-observed"] }, price: { type: "string", description: "the item price you saw (alias price_seen)" }, price_seen: { type: "string" }, price_paid: { type: "string", description: "what you actually paid, if you paid" }, fee: { type: "string", description: "a store or payment fee, e.g. a gift-card fee" }, shipping_source: { type: "string", enum: ["policy", "checkout", "unknown"], description: "where the shipping amount came from: the store's shipping policy, the checkout itself, or unknown" }, price_source: { type: "string", enum: ["klickymart", "store"], description: "price copied from KlickyMart data or read on the store" }, strict: { type: "boolean", description: "reject unknown fields instead of ignoring them with a warning" }, estimated: { oneOf: [{ type: "boolean" }, { type: "string" }, { type: "array", items: { type: "string" } }], description: "true = every amount you give is an estimate; false = none; or a list of amount kinds you estimated (array or comma string, e.g. tax,total)" }, shipping: { type: "string" }, tax: { type: "string" }, total: { type: "string" }, currency: { type: "string" }, region: { type: "string", description: "ZIP3, US-XX or country code" }, duration_s: { type: "string" }, steps: { type: "array", items: { type: "string" } }, agent: { type: "string" }, delivered: { type: "string", enum: ["true", "false", "unknown", "yes", "no"] }, delivery_days: { type: "string" }, rating: { type: "integer", minimum: 1, maximum: 5 }, narrative: { type: "string" } } },
      },
      {
        name: "get_checkout_map",
        description: "Checkout steps our probe reached for a store (stopping at the payment screen, never submitting), the first blocker (bot-wall, http-refusal, network-error, no-product-link, no-add-to-cart, form-gate, login-wall, robots, unclassified, none) and landed-cost signals.",
        inputSchema: { type: "object", required: ["domain"], properties: { domain: { type: "string" } } },
      },
      {
        name: "recheck_domain",
        description: "Re-read robots.txt and the home-page status for an indexed store now. Max 1 per store per 10 minutes (else cached result + next_allowed_at), 60 per hour overall.",
        inputSchema: { type: "object", required: ["domain"], properties: { domain: { type: "string" } } },
      },
      {
        name: "watch_item",
        description: "DRAFT (GO D8, not served yet): returns an unsigned kind 420 watch template for price/stock changes. KlickyMart does not act on watches yet and never signs for you.",
        inputSchema: { type: "object", properties: { gtin: { type: "string" }, domain: { type: "string" }, max_price: { type: "number" }, in_stock: { type: "boolean" }, note: { type: "string" } } },
      },
      {
        name: "find_alternatives",
        description: "Where else can my agent buy this? Give a blocking domain and/or a category (electronics, gift-cards, groceries, apparel, hardware, books, travel, crypto-hardware, other, or a product word like headphones). Product words resolve to a finer sub (headphones -> audio). Returns in-map stores an agent can reach that sell that product family, ranked by checkout reached, major retailer, main product line, agent access, BTC grade, checkout ease, each with an evidence URL, plus turned_away stores with reasons. Index only; never crawls.",
        inputSchema: {
          type: "object",
          properties: { include_indirect: { type: "boolean", description: "with pay=btc/lightning: also list stores where bitcoin works only through a third-party processor or gift card (labelled btc_route indirect). Default: native acceptance only." }, 
            domain: { type: "string" }, category: { type: "string", description: "coarse category or product word (headphones, laptop, gift card...)" },
            sub: { type: "string", enum: [...SUBCATEGORIES], description: "product family" },
            pay: { type: "string", enum: Object.keys(ALT_PAY_FILTERS) }, guest: { type: "boolean", description: "exclude stores known to require an account" },
            zip: { type: "string", description: "5-digit US ZIP: adds landed cost per store" }, taxpre: { type: "boolean", description: "with zip: only stores observed to show shipping and tax before payment" },
            limit: { type: "integer", maximum: 50 },
          },
        },
      },
      {
        name: "find_agent_native",
        description: "Agent-native stores: sellers an agent can pay without a browser checkout (L402/x402 paid APIs, VPN, eSIM, VPS, gift cards, nostr-native, agent-commerce). Each item has agent_native {category, label verified-402|claimed, rails, rails_status, probe_402 with price_seen}. verified-402 = our one unauthenticated request got a real HTTP 402 challenge; we never paid. Stores that refuse agents are returned as findings (status not crawled), never as options. Index only.",
        inputSchema: { type: "object", properties: {
          category: { type: "string", enum: [...Object.keys(AN_ALT_CATEGORIES), ...AN_CATS] },
          rail_status: { type: "string", enum: ["verified-402", "claimed"] },
          reachable_only: { type: "boolean", description: "default false: findings (blocked-tos, agents-not-welcome, error) are included and labelled" },
          limit: { type: "integer", maximum: 100 },
        } },
      },
      {
        name: "get_reviews",
        description: "Kind 422 reviews of a merchant (signed claims by pseudonymous keys; not verified by KlickyMart).",
        inputSchema: { type: "object", required: ["domain"], properties: { domain: { type: "string" } } },
      },
      {
        name: "submit_review",
        description: "Submit a kind 422 shopping-experience note or review you already signed locally (never send a secret key). Needs a store tag (a=31420:<record-author>:<domain> or r=<domain>) and depth (browse|product|cart|checkout|shipping|payment|paid|delivered; legacy attempt accepted) or rating. Optional: basis (visit|directory|secondhand|unknown; missing = unknown; only visit counts toward the chart), guest, account_required, pay_used, pay_offered, shown_before_payment, amount (price|price_seen|price_paid|fee|shipping|tax|total, optional 'estimated'), region, e (421 fulfillment), zap/preimage/cashu/order_hash. Build the tags with build_experience_note. The reply includes basis and counts_toward_chart. Use a fresh keypair dedicated to KlickyMart for pseudonymity. See /llms.txt.",
        inputSchema: {
          type: "object",
          required: ["event"],
          properties: { event: { type: "object", description: "Signed Nostr event JSON (id, pubkey, created_at, kind 422, tags, content, sig)" }, dry_run: { type: "boolean" } },
        },
      },
      {
        name: "submit_store",
        description: "Suggest a store KlickyMart has not indexed yet. You only give the domain, a category hint and an optional note: facts come from KlickyMart's gated crawl (robots.txt and ToS first), never from you. Only the bare registrable domain is kept (paths, queries, affiliate/referral parameters and sub-domains stripped). Returns {id, domain, status: queued|duplicate|rejected, reason, trust_tier}. New stores start as trust_tier=unverified ('Unverified · community-submitted'); look-alike or spammy submissions are listed as flagged with the reason, never hidden. Limits: 10/day and 50/week per submitter and per salted network hash. dry_run=true validates without storing. Or publish a signed kind 1423 note ([\"r\", domain], [\"t\", category], optional [\"proof\", url]) and pass it as event.",
        inputSchema: { type: "object", properties: { domain: { type: "string", description: "Store domain, e.g. shop.example" }, category: { type: "string", description: "Category hint (optional)" }, evidence_url: { type: "string", description: "https page on the same store (optional)" }, note: { type: "string", description: "Up to 280 chars; links are removed" }, agent_name: { type: "string", description: "Optional agent name (stored only as a salted id)" }, event: { type: "object", description: "Optional signed kind 1423 event instead of domain" }, dry_run: { type: "boolean" } } },
      },
      {
        name: "wallet_setup_guide",
        description: "Non-custodial wallet setup guide for agents: Nostr key, self-custodial or agent-friendly Lightning options (NWC, Alby Hub, phoenixd, LNbits) with who holds the funds, how to get a lud16 for tips, Cashu wallets and mint risk, plus a checklist. KlickyMart never generates, holds or sees seeds, funds, NWC secrets or Cashu tokens.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "facilitate_purchase",
        description: "For a store that has NOT claimed its KlickyMart listing: show KlickyMart your payment proof and get back a kind 421 signed by KlickyMart as FACILITATOR (role=facilitator, on_behalf_of=<domain>, verification=verified-preimage|verified-zap|unverified-claim). It is NOT a store confirmation. KlickyMart does not publish it; you publish it, then reference it from your 422. Never send a secret key or the raw receipt (send a sha256 hash of a redacted receipt instead).",
        inputSchema: {
          type: "object", required: ["domain", "agent_pubkey", "proof"],
          properties: {
            domain: { type: "string" }, agent_pubkey: { type: "string", description: "your 64-hex public key" }, need_id: { type: "string", description: "optional id of your kind 420" },
            proof: { type: "object", description: "{type:'preimage',preimage,bolt11} | {type:'zap',receipt:<signed 9735>}" },
          },
        },
      },
    ],
  };
  // KM-002: facilitate_purchase is hidden while facilitation is paused.
  return opts.facilitate ? all : { tools: all.tools.filter((t) => t.name !== "facilitate_purchase") };
}

/** D8 draft: an UNSIGNED kind 420 "watch" need template. KlickyMart never signs for the caller and does not yet act on watches. */
export function watchTemplate(a: Record<string, unknown>) {
  const tags: string[][] = [["t", "watch"]];
  if (a.gtin) tags.push(["l", `gtin:${String(a.gtin)}`, "nip-xx"]);
  if (a.domain) tags.push(["r", String(a.domain)]);
  if (a.max_price) tags.push(["cond", "price<", String(a.max_price), "USD"]);
  if (a.in_stock) tags.push(["cond", "stock", "in"]);
  tags.push(["expiration", String(Math.floor(Date.now() / 1000) + 30 * 86400)]);
  return { status: "draft: watches are not served yet (GO D8). Today 'watch' on KlickyMart means KlickyMart watching relays for reviews.", unsigned_event: { kind: 420, content: String(a.note ?? ""), tags }, spec: "/llms.txt#watch" };
}

/** Versions whose basic tools/list + tools/call over plain JSON responses we serve. */
export const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];

export type McpHandler = (method: string, params: unknown, id: unknown) => Promise<{ jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } }>;

export function createMcpHandler(deps: {
  runQuery: (sp: URLSearchParams) => Promise<{ body: unknown; filter_ms: number }>;
  getRecord: (domain: string) => Promise<{ body: unknown } | null>;
  findAlternatives?: (args: Record<string, unknown>) => { ok: true; body: unknown } | { ok: false; message: string } | Promise<{ ok: true; body: unknown } | { ok: false; message: string }>;
  facilitate?: (args: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
  submitReview?: (event: unknown, dryRun: boolean) => Promise<{ status: number; body: Record<string, unknown> }>;
  submitStore?: (args: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
  getReviews?: (domain: string) => Promise<unknown>;
  checkDomain?: (domain: string) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }>;
  checkDomainZip?: (domain: string, zip: string | null) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }>;
  landedPrice?: (args: Record<string, unknown>) => Promise<{ ok: true; body: unknown } | { ok: false; message: string }>;
  findOffers?: (args: Record<string, unknown>) => Promise<{ ok: true; body: unknown } | { ok: false; message: string }>;
  getCheckoutMap?: (domain: string) => Promise<unknown>;
  recheckDomain?: (domain: string) => Promise<unknown>;
  buildExperienceNote?: (args: Record<string, unknown>) => { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string };
}): McpHandler {
  return async (method, params, id) => {
    const base = { jsonrpc: "2.0" as const, id };
    if (method === "ping") return { ...base, result: {} };
    if (method === "initialize") {
      const asked = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return {
        ...base,
        result: {
          protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "klickymart", version: "1.0.0" },
        },
      };
    }
    if (method === "tools/list") return { ...base, result: mcpToolsList({ facilitate: !!deps.facilitate }) };
    if (method === "tools/call") {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      if (p.name === "search_merchants") {
        const sp = queryParamsToMcpArgs(p.arguments ?? {});
        if (!sp.has("limit")) sp.set("limit", "50");
        const limit = parseInt(sp.get("limit") ?? "50", 10);
        if (limit > 100) sp.set("limit", "100");
        const { body } = await deps.runQuery(sp);
        const items = (body as { items?: { d: string; name: string | null; record: string }[] }).items ?? [];
        const text = items.map((i) => `${i.d} ${i.name ?? ""} ${i.record}`.trim()).join("\n") || "no matches: 0 results for these filters";
        return {
          ...base,
          result: {
            content: [{ type: "text", text }],
            structuredContent: body,
          },
        };
      }
      if (p.name === "find_agent_native") {
        const a = p.arguments ?? {};
        const sp = new URLSearchParams({ agent_native: "1", limit: String(Math.min(100, Number(a.limit) || 50)), sort: "status,d" });
        if (typeof a.category === "string") sp.set("an_cat", a.category);
        if (typeof a.rail_status === "string") sp.set("rail_status", a.rail_status);
        if (a.reachable_only === true) sp.set("status", "crawled");
        const { body } = await deps.runQuery(sp);
        const items = (body as { items?: { d: string; status: string; record: string; agent_native?: { category: string; label: string } }[] }).items ?? [];
        const text = items.map((i) => `${i.d} [${i.agent_native?.category ?? "?"}; ${i.agent_native?.label ?? "claimed"}]${i.status === "crawled" ? "" : ` [FINDING, DO NOT USE: ${i.status}]`} ${i.record}`).join("\n") || "no matches";
        return { ...base, result: { content: [{ type: "text", text }], structuredContent: body } };
      }
      if (p.name === "get_record") {
        const domain = String(p.arguments?.domain ?? "");
        if (!domain) return { ...base, error: { code: -32602, message: "domain required" } };
        const rec = await deps.getRecord(domain);
        if (!rec) return { ...base, error: { code: -32001, message: "not found" } };
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(rec.body) }], structuredContent: rec.body } };
      }
      if (p.name === "find_alternatives" && deps.findAlternatives) {
        const r = await deps.findAlternatives(p.arguments ?? {});
        if (!r.ok) return { ...base, error: { code: -32602, message: r.message } };
        const items = (r.body as { items: { d: string; checkout: number | null; btc_grade: number | null; evidence: string }[] }).items;
        return { ...base, result: { content: [{ type: "text", text: items.map((i) => `${i.d} co=${i.checkout ?? "?"} btc=${i.btc_grade ?? "?"} ${i.evidence}`).join("\n") || "no matches" }], structuredContent: r.body } };
      }
      if (p.name === "get_reviews" && deps.getReviews) {
        const domain = String(p.arguments?.domain ?? "");
        if (!domain) return { ...base, error: { code: -32602, message: "domain required" } };
        const body = await deps.getReviews(domain);
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body } };
      }
      if (p.name === "wallet_setup_guide") {
        const body = { ...WALLET_GUIDE, page: "/wallet" } as Record<string, unknown>;
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body } };
      }
      if (p.name === "facilitate_purchase" && deps.facilitate) {
        const r = await deps.facilitate((p.arguments ?? {}) as Record<string, unknown>);
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(r.body) }], structuredContent: r.body, isError: r.status >= 400 } };
      }
      if (p.name === "submit_store" && deps.submitStore) {
        const r = await deps.submitStore((p.arguments ?? {}) as Record<string, unknown>);
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(r.body) }], structuredContent: r.body, isError: r.status >= 400 } };
      }
      if (p.name === "submit_review" && deps.submitReview) {
        const r = await deps.submitReview(p.arguments?.event, p.arguments?.dry_run === true);
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(r.body) }], structuredContent: r.body, isError: r.status >= 400 } };
      }
      if (p.name === "build_experience_note" && deps.buildExperienceNote) {
        const r = deps.buildExperienceNote(p.arguments ?? {});
        if (!r.ok) return { ...base, error: { code: -32602, message: r.message, data: { code: r.code, retryable: false } } };
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(r.value) }], structuredContent: r.value } };
      }
      if (p.name === "get_landed_price" && deps.landedPrice) {
        const r = await deps.landedPrice(p.arguments ?? {});
        if (!r.ok) return { ...base, error: { code: -32602, message: r.message, data: { retryable: false, hint: "zip is required; give q, gtin, mpn or url" } } };
        const items = (r.body as { items: { title?: string; name?: string; domain?: string; price?: number; currency?: string; url?: string; source?: string; landed?: { est_total?: number | null; est_tax?: number | null; shipping?: { usd?: number | null } }; store?: { indexed?: boolean; co?: number | null; guest?: boolean | null } }[] }).items;
        const text = items.map((i) => `${flagPrefix(i as Record<string, unknown>)}${i.domain ?? ""} ${i.currency ?? ""} ${i.price ?? "?"} ship=${i.landed?.shipping?.usd ?? "unknown"} tax~${i.landed?.est_tax ?? "?"} total=${i.landed?.est_total ?? "unknown"} | ${i.store?.indexed === false ? "store not indexed" : `co=${i.store?.co ?? "?"} guest=${i.store?.guest ?? "?"}`} | ${i.title ?? i.name ?? ""} ${i.url ?? ""} [${i.source ?? ""}]`).join("\n") || "no products found";
        return { ...base, result: { content: [{ type: "text", text }], structuredContent: r.body } };
      }
      if (p.name === "find_offers" && deps.findOffers) {
        const r = await deps.findOffers(p.arguments ?? {});
        if (!r.ok) return { ...base, error: { code: -32602, message: r.message } };
        const items = (r.body as { items: { domain: string; name: string; price: number; currency: string; stock: string | null; url: string }[] }).items;
        const live = (r.body as { live_shopify_catalog?: { ok?: boolean; error?: string; filter_note?: string; items?: { title?: string; price?: number; currency?: string; stock?: string | null; url?: string; store?: { indexed?: boolean; co?: number | null; guest?: boolean | null; pay?: string[] } ; landed?: { est_total?: number | null } }[] } }).live_shopify_catalog;
        const liveLines = live ? (live.ok ? [...(live.items ?? []).map((i) => `[Shopify Catalog live, not stored] ${i.currency ?? ""} ${i.price ?? "?"} ${i.stock ?? "?"} ${i.title ?? ""} ${i.url ?? ""} | store: ${i.store?.indexed ? `co=${i.store.co ?? "?"} guest=${i.store.guest ?? "?"} pay=${(i.store.pay ?? []).join(",") || "?"}` : "not indexed"}${i.landed ? ` | est_total=${i.landed.est_total ?? "unknown"}` : ""}`), ...(live.filter_note ? [live.filter_note] : [])] : [`[Shopify Catalog live] error: ${live.error ?? "unknown"}`]) : [];
        return { ...base, result: { content: [{ type: "text", text: [...items.map((i) => `${i.domain} ${i.currency} ${i.price} ${i.stock ?? "?"} ${i.name} ${i.url}`), ...liveLines].join("\n") || "no offers observed" }], structuredContent: r.body } };
      }
      if (p.name === "get_checkout_map" && deps.getCheckoutMap) {
        const b = await deps.getCheckoutMap(String(p.arguments?.domain ?? ""));
        if (!b) return { ...base, error: { code: -32001, message: "not in index" } };
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(b) }], structuredContent: b } };
      }
      if (p.name === "recheck_domain" && deps.recheckDomain) {
        const b = await deps.recheckDomain(String(p.arguments?.domain ?? ""));
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(b) }], structuredContent: b } };
      }
      if (p.name === "watch_item") {
        const b = watchTemplate(p.arguments ?? {});
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(b) }], structuredContent: b } };
      }
      if (p.name === "check_domain" && (deps.checkDomainZip || deps.checkDomain)) {
        const zip = p.arguments?.zip ? String(p.arguments.zip) : null;
        const r = deps.checkDomainZip ? await deps.checkDomainZip(String(p.arguments?.domain ?? ""), zip) : await deps.checkDomain!(String(p.arguments?.domain ?? ""));
        if (!r.ok) return { ...base, error: { code: -32602, message: r.message } };
        const b = r.body as { domain: string; verdict: string };
        return { ...base, result: { content: [{ type: "text", text: `${b.domain}: ${b.verdict}\n${JSON.stringify(r.body)}` }], structuredContent: r.body } };
      }
      return { ...base, error: { code: -32601, message: "unknown tool" } };
    }
    return { ...base, error: { code: -32601, message: `method not found: ${method}` } };
  };
}

export function parseMcpRequest(body: string): { method: string; params: unknown; id: unknown; isNotification: boolean } | null {
  try {
    const j = JSON.parse(body) as { method?: string; params?: unknown; id?: unknown };
    if (!j.method) return null;
    return { method: j.method, params: j.params, id: j.id ?? null, isNotification: !("id" in j) };
  } catch {
    return null;
  }
}

export { validateQueryParams };
export type { QueryParams };
