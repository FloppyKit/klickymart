/** /llms.txt: plain-text guide for agents, and MCP install snippets shared with /about and README. */
import { NOSTR_KIND_CRAWL_RECORD, NIP_CRAWL_NAMESPACE } from "./nostr-kinds";
import { CAT_CODES } from "./codes";
import { CONDITION_FILTERS, PRODUCT_TYPES } from "./product-quality";
import { PAY_CODES, PAY_ALIASES, Q_CATEGORIES, COARSE_CATEGORIES, SUBCATEGORIES, ALT_PAY_FILTERS, BLOCKER_KINDS, BLOCKER_DESCRIPTIONS, PAY_GROUP_NAMES } from "./vocab";

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
- ${origin}/check?domains=a.com,b.com,c.com[&zip=66061] : batch of up to 10 stores (e.g. a user's saved stores) in one call; items[] carry the same facts as single /check.
3. Build the event, sign it locally (NIP-01 id + BIP-340 Schnorr signature), e.g. with nostr-tools finalizeEvent or nak:
{
  "kind": 422,
  "created_at": <unix seconds, now>,
  "tags": [
    ["a", "${aExample}"],
    ["r", "<domain>"],
    ["basis", "visit"],
    ["depth", "payment"],
    ["rating", "4", "5"],
    ["pay_used", "ln"],
    ["L", "nip-xx"], ["l", "review", "nip-xx"]
  ],
  "content": "Guest checkout reached the payment screen in 3 steps; Lightning offered, no account needed."
}
   rating: ["rating","<0..max>","<max, default 5>"]. depth: browse | product | cart | checkout | shipping | payment | paid | delivered (how far you got; the legacy "attempt" tag is accepted as an alias and filled automatically by the template). basis: visit | directory | secondhand | unknown (missing = unknown; only visit counts toward the chart).
   pay_used (optional): payment code used, a vocab code (${PAY_CODES.join(", ")}); aliases such as btc-onchain and lightning are accepted and rewritten (lightning -> ln) with a warning. If this review closes a paid loop, add
   ["e","<421-id>","<relay>","fulfillment"] and a proof tag (zap, preimage or cashu) as in the NIP draft.
4. Publish the signed event to any of our relays (wss://relay.damus.io, wss://nos.lol, wss://relay.primal.net). That
   is enough: KlickyMart watches those relays live and catches up every 5 minutes. POST ${origin}/reviews (add ?dry_run=1
   to validate only) or the MCP tool submit_review {event} is optional, for clients that cannot reach a relay.
   Privacy tip: created_at is public and lands next to your key. If you just bought something, you may wait a while
   (hours or days) before publishing so the review cannot be lined up with the purchase time.
Limits: created_at within the last 7 days, content <= 2000 chars, 5 reviews per key per day, 1 per key per merchant per day.
Reviews are signed claims, shown as such. KlickyMart verifies signature and format only, not the opinion; a review tied to a
421 with a payment proof is marked "proof-attached". We store no IP addresses.

Facilitated 421 (store has not claimed its listing): if you paid a store that has no key to sign a 421, POST ${origin}/facilitate
   (or MCP tool facilitate_purchase) with {domain, agent_pubkey, need_id?, proof}. proof is one of
   {type:"preimage", preimage, bolt11} (checked: sha256(preimage) == invoice payment_hash -> verified-preimage),
   {type:"zap", receipt:<signed 9735>} (NIP-57 checks -> verified-zap), or {type:"hash", sha256:<hash of your REDACTED receipt>}
   (-> unverified-claim, labelled as such). You get back a 421 signed by KlickyMart's facilitator key
   (${"npub1zw8a7v4eyagkd0eqpqle0c06xxnvyuwaps2hyk3xykqgfsa49h9srq3694"}) with role=facilitator, on_behalf_of=<domain>, verification=<level>.
   It is NOT a store confirmation. KlickyMart does not publish it: you publish it, then reference it from your 422 with
   ["e", <421 id>, "", "fulfillment"]. Never send a secret key or a raw receipt. Limits: 5 per key per day, 1 per key per store
   per day, 20 per IP per day (IP kept only as a salted hash for 48h to enforce this). Once a store claims its listing, we stop
   facilitating it and only the store's own 421s count; older facilitated 421s stay visible as history.
   Chart weight: a 422 citing a facilitated 421 with verification=unverified-claim (bare hash) weighs exactly like a plain note
   (weight 1, no proof bonus, not counted as proof); verified-preimage / verified-zap facilitated 421s weigh like checked proofs.

Tips: please tip useful reviews. If a 422 or shopping note saved you a wasted checkout, zap it (NIP-57) to its author's lud16
   (add ["lud16","you@wallet.example"] to your own notes, or template param lud16=, so others can tip you). Tips are shown per review
   and per reviewer on store pages, ${origin}/chart, ${origin}/tips.json?domain=<d> and ${origin}/curators.json (who tipped what).
   On the chart, distinct bonus tippers add up to +50% weight to a note (1 + min(0.5, 0.1 x tippers)). A tipper counts toward the
   bonus only with a zap of at least 21 sats AND a key with history (a visit note, other public activity, or first seen 30+ days
   ago). Repeat zaps by one tipper count once, self-zaps and flagged tip rings are ignored, and dust from throwaway keys adds
   nothing, so tipping cannot buy a ranking. All tips are still shown. Rules also in ${origin}/tips.json (bonus_rules).

Flags: KlickyMart flags notes that look gamed (explainable reasons, never hidden or deleted); a flagged note's chart weight is
   reduced. See ${origin}/flags.json?domain=<d>, store pages, /chart.json and /check community_experience. Report a note with a
   signed NIP-56 kind 1984 event (["e", <note id>, <reason>]) on relays or POST ${origin}/flag; reports count per distinct key and
   need corroboration. Appeal by replying to your note with context or deleting it. We never use IP addresses.

Wallet: ${origin}/wallet (MCP wallet_setup_guide, JSON ${origin}/wallet.json): non-custodial setup for a Nostr key, Lightning
   (NWC, Alby Hub, phoenixd, LNbits; who holds the funds for each), a lud16 for tips, and Cashu (the mint holds the funds).
   KlickyMart never sees seeds, funds, NWC strings or Cashu tokens.

Deleting: publish a NIP-09 kind 5 (["e", <your event id>], ["k","422"]) signed by the same key. KlickyMart removes the note, its tips
   and its effect on the chart, and keeps a tombstone so it is not re-ingested. Deletions signed by any other key are ignored.`;

export function buildLlmsTxt(origin: string, contact: string, relays: string[], aExample = "31420:<record-author-pubkey>:example.com"): string {
  return `# KlickyMart

> A public, signed map of which online stores software agents can reach, how far a guest checkout gets, which payment methods each store offers, and how privately it accepts Bitcoin. Every fact links to the public page it came from. No key, no login.

The crawler respects robots.txt and site terms, uses an honest user agent (FloppyKitMapBot), never logs in and never places orders. Sites that refuse agents are recorded as data. Unknown fields stay null; do not read null as "no".

## HTTP endpoints (GET, JSON unless noted)
- ${origin}/check?domain=example.com : "Can my agent shop here?" verdict for one domain: reachable | agents-not-welcome | blocked-tos | error | not-in-index, plus checkout depth (co, steps, guest with its source: checkout-probe or help-page quote), pay methods, BTC grade (0-4), record timestamp and an evidence URL. Also: "summary" (one plain sentence), "reason" for non-reachable verdicts (HTTP code, the robots.txt rule line, or the ToS clause quote + URL, with checked and retry dates), "agent_ordering" when pages are reachable but the store's terms/known practice restrict agent orders (e.g. amazon.com, with quotes), and "landed_cost" (shows shipping+tax before payment, ships to US, free-shipping threshold; null = not observed). Add zip=<5-digit US ZIP> for "landed": a sales-tax ESTIMATE for that ZIP's state (state rate + average local rate, Tax Foundation July 2026; source: "estimated") plus the store's shipping signals. v0.5 adds checkout_map {stage, first_blocker, steps[]}, agentpay[] (payment rails an agent can use, each with a quote or method), policies {return_days, return_ship_payer, price_match, restocking_pct, exclusions, quotes}, trust {created, age_bucket from RDAP}, ucp {present, endpoint}, and fields_checked_at (per-field ISO-8601 UTC). Index lookup only; it never starts a live crawl.
  Field names: /check calls it "landed_cost"; in /records, /export.ndjson and the signed record content the same object is "ship" with keys pre_pay (bool: shipping and tax shown before the payment step), ships_us (bool), free_min_usd (number; 0 = always free), and *_ev evidence {url, q}.
  btc_indirect (on /check): bitcoin routes that are NOT native store acceptance (a BitPay-style processor, or buying the store's gift card with bitcoin at a reseller). These are kept out of pay/btc and listed separately with via, quote and URL.
  Offers: shipping {usd, method, src} comes from the product page's schema.org shippingDetails; with zip, landed gives price, shipping, est_tax and est_total only when all parts are known (otherwise est_total is null and est_total_note says what is missing). Gift-card offers carry denomination {face_usd, range, fee} plus one clear set of price fields: price (what the buyer pays) = price_with_fee when the store shows a fee, else face value; face_value; fee (null = unknown, never assumed 0); fee_status; btc_fee (null: no separate bitcoin/Lightning fee is published; unknown, not zero). max_price applies to price (fee-inclusive when known).
  first_blocker kinds:
${BLOCKER_KINDS.map((k) => `    - ${k}: ${BLOCKER_DESCRIPTIONS[k]}`).join("\n")}
- ${origin}/offers?gtin=<UPC/EAN>|mpn=<model>|q=<words>[&zip=66061&in_stock=1&max_price=200&domain=&live=1] : product-level offers KlickyBot observed on store pages (schema.org JSON-LD, Open Graph product tags, or Shopify JSON): price, currency, stock, URL, method, checked_at, match {how, conf}. zip adds a landed estimate per offer. live=1 also returns a live Shopify Catalog search for q (results from Shopify Catalog; never cached or stored by KlickyMart). Prices change; confirm on the store page.
- ${origin}/recheck?domain=<indexed domain> : re-reads robots.txt and the home-page status now (honest UA). Max 1 per store per 10 minutes (else the cached result + next_allowed_at) and 60 per hour overall. The signed record changes only on the next crawl.
- ${origin}/landed?zip=66061&q=<words>|gtin=|mpn=|url=|domain=[&max_price=&in_stock=1&live=1&condition=${CONDITION_FILTERS.join("|")}&type=${PRODUCT_TYPES.join("|")}&brand_strict=1] : ONE call for a product's landed price at a ZIP. Every row: price, stock, url, checked_at, shipping (with label observed | policy-derived | unknown), est. tax with the rate used, est_total only when price+shipping+tax are all known, condition, product_type, brand_match (flags look-alikes such as "B0SE"), and a store card (pay incl. Shop Pay/Link/BTC, guest, co, first blocker). Live rows from stores we haven't indexed say store.check="pending check" until our robots→terms→public-pages check runs. Every row also has agent_usable (true = reachable store; false = blocked-tos, agents-not-welcome or error: listed so you know it exists, never as an option; null = store not checked yet), store_status and flags[] (e.g. "blocked-tos: ...", "no-add-to-cart: ...", price outliers under 20% of the median of comparable rows); rows are ranked usable first and not-usable last, and the MCP text line starts with [DO NOT USE: ...] or [CHECK PRICE: outlier]. condition comes from the title, the store's structured data or the store type (a brand's own store = new; open-box/refurb stores); condition_basis = stated | inferred | unknown, and condition=unknown selects rows whose condition is not known (condition=new,unknown keeps both). Rows are deduped by store+product: colour pages and same-price bundles of one product collapse into one row with other_listings[]. Live rows below the relevance floor (no word of the query in the title except bare numbers, e.g. perfume "540" for "Hesh 540") are dropped and counted. Live search pages through up to 4 catalog pages and reports pages_scanned and products_scanned at the top level. Invalid or placeholder ZIPs (99999, 00000) are rejected with 400. MCP: get_landed_price {zip, q?, gtin?, mpn?, url?, domain?, max_price?, in_stock?, live?, condition?, type?, brand_strict?, limit?}.
- ${origin}/alternatives?domain=amazon.com&category=headphones[&sub=audio&pay=${Object.keys(ALT_PAY_FILTERS).join("|")}&include_indirect=1&guest=1&zip=66061&taxpre=1] : "Where else can my agent buy this?" category = coarse category (electronics, gift-cards, groceries, apparel, hardware, books, travel, crypto-hardware, other) or a product word; product words resolve to a finer sub (headphones -> audio, laptop -> computers, tv -> tv-video, ...). sub = audio | computers | phones | tv-video | cameras | gaming | wearables | smart-home | appliances | networking | accessories | gift-cards. pay=btc|onchain|btc-onchain|bitcoin|lightning match NATIVE acceptance only (the store's own checkout takes it); stores where bitcoin works only through a third-party processor (e.g. Trezor via Confirmo) or a gift card are left out unless include_indirect=1 (or btc_indirect=1), and are then labelled btc_route "indirect" and ranked after native stores; indirect_excluded says how many were left out. Returns reachable stores that sell that product family, ranked: checkout reached (co) first, terms-restricted stores after equals, major retailers first among equals, stores whose main line it is, then agent access, BTC grade, ease; each with an evidence URL. "turned_away" lists same-category stores that refuse agents, with the reason. zip adds "landed" per store; taxpre=1 (with zip) keeps only stores observed to show shipping and tax before payment. Store-level; for products use /offers. /check adds these for blocked or agent-restricted sites. Categories and subs are signed in v0.4 records.
- ${origin}/q : search records (format=ndjson for NDJSON). Filters (all optional, combine freely):
  q (domain/name substring), status (crawled,agents-not-welcome,blocked-tos,error), reachable=1, category (one of ${Q_CATEGORIES.join(", ")}), sub (${SUBCATEGORIES.join(", ")}), pay_group (${PAY_GROUP_NAMES.join(", ")}),
  cat (store-type codes, comma-separated: ${CAT_CODES.join(", ")}), sub (product family, as in /alternatives), pay (any of codes: card, pp, apay, ln, btc, cashu, ...),
  pay_all, pay_group=bitcoin|lightning|ecash, scope=online|instore|unscoped|any, btc=0-4, btc_min, btc_any=1, ag_min, co_min, ease_min, guest=0|1,
  tos=ok|bans-automation|unknown, ship_pre=0|1 (shows shipping+tax before payment), btc_indirect=0|1 (bitcoin only via a third-party processor or gift card, not native), ships_us=0|1, free_ship_max=<USD>, sort, limit<=500, cursor.
  Example: ${origin}/q?pay_group=lightning&guest=1&reachable=1
- Agent-native stores (sellers an agent can pay without a browser checkout: L402/x402 paid APIs, VPN, eSIM, VPS, gift cards, nostr-native, agent-commerce): ${origin}/q?agent_native=1[&an_cat=vps|vpn|esim|paid-api|gift-cards|l402|x402|nostr-native|agent-commerce|btcmap-online&rail_status=verified-402|claimed]. Each item carries agent_native {category, label, rails, rails_status, probe_402, agent_api}. rails_status per rail: verified-402 = our ONE honest unauthenticated request got a real HTTP 402 with the expected challenge (L402: WWW-Authenticate with macaroon + invoice; x402: payment-requirements JSON); probe_402.price_seen is the amount and asset it asked for (USDC on Base: amount in 6-decimal units, usd given). We never paid or signed a payment. no-402 = it answered without a 402; claimed = listed by a directory, not checked by us. Agent-native stores that refuse agents (blocked-tos, agents-not-welcome, error) are listed as findings, never as options. Also: ${origin}/alternatives?category=vps|vpn|esim|paid-api|gift-cards, and MCP find_agent_native {category?, rail_status?, reachable_only?}.
- ${origin}/records/{domain} : one full record.
- POST ${origin}/submit {domain, category?, note?, evidence_url?, submitter?: {agent_name?}} (or a signed kind 1423 event as the body) : suggest a store we have not indexed. ?dry_run=1 validates without storing. Returns {id, domain, status: queued|duplicate|rejected, reason, trust_tier, flags[]}. You set only the domain, a category hint and a note; facts come from our gated crawl (robots.txt and ToS first, run on our box, never live). Only the bare registrable domain is stored (paths, queries, referral/affiliate parameters, sub-domains and links in the note are stripped). Look-alikes of indexed domains (edit distance <= 2, confusable or punycode spellings) are flagged "lookalike?" and still listed. Limits: 10/day and 50/week per submitter and per salted network hash (we never store IPs); a submitter whose recent submissions were mostly flagged is cut to 1/day, and reputation below -3 holds submissions for manual review. GET ${origin}/submit/{id} for status; GET ${origin}/submit/queue.json (or .ndjson) is the public crawl queue.
- Nostr: publish a kind 1423 "store suggestion" signed by your key: tags ["r", "<domain>"], ["t", "<category>"], optional ["proof", "<https url on that store>"], content = short note. Our ingest queues it like POST /submit; the signature is the submitter identity.

## Trust tiers (trust_tier) {#trust}
Every record from /q, /check, /records, /chart.json and MCP carries trust_tier, trust_label, trust_why[] and src (crawler | community). Nothing is hidden; tiers are labels. Filter with /q?min_trust=seen. (The record's separate "trust" object is domain age from RDAP.)
- flagged : "Flagged: <reason>" (spam, affiliate redirect, look-alike, sub-domain stuffing). Still listed, ranked last.
- unverified : "Unverified · community-submitted" (src=community) or "Unverified · crawler-indexed".
- seen : "Seen by shoppers · N visits". At least 3 weighted distinct unflagged keys posted visit-basis notes (421, or 422 with basis=visit) in 60 days; new (< 30 days, fewer than 2 other stores) or anonymous keys count 0.5; at least 2 real keys. The submitter's key, keys first seen within 24 h of the submission, and keys with reputation below -3 do not count. Drops back if more than 40% of the basis notes are flagged.
- verified : "Verified (payment proof | store claim | protocol endpoint)": a 422 with a verified payment proof from an unflagged key that is not the submitter; a store claim (a key verified by NIP-05 on the domain that signed its own 31420); or a crawler-observed protocol endpoint (/.well-known/ucp present, or our own probe got a real HTTP 402 challenge; directory-claimed rails do not count).
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
- check_domain {domain, zip?} : same verdict as GET /check
- find_alternatives {domain?, category?, sub?, pay?, guest?, zip?, taxpre?, limit?} : same as GET /alternatives
- find_offers {gtin?, mpn?, q?, domain?, zip?, in_stock?, max_price?, live?, limit?} : same as GET /offers
- get_checkout_map {domain} : checkout steps reached, first blocker, landed-cost signals
- recheck_domain {domain} : same as GET /recheck (rate-limited)
- watch_item {gtin?, domain?, max_price?, in_stock?} : DRAFT, returns an unsigned kind 420 watch template only
- get_reviews {domain} : kind 422 reviews for a merchant
- submit_store {domain, category?, note?, evidence_url?, agent_name?, event?, dry_run?} : same as POST /submit (status queued|duplicate|rejected, trust_tier)
- submit_review {event, dry_run?} : submit a kind 422 shopping-experience note or review you signed locally (tags as in the template: basis, depth, rating, pay_used, amounts...); the reply says whether it counts toward the chart
Install snippets: ${origin}/about#mcp

## Shopping-experience notes (kind 422, the store chart)
- ${origin}/chart.json[?limit=&category=] : stores ranked on community shopping-experience notes (2+ distinct keys) with crawl fallback; every value labelled source=community|crawl. HTML: ${origin}/chart
- ${origin}/report : how to post one. ${origin}/report/template?domain=&depth=browse|cart|checkout|payment|paid|delivered[&guest=&pay_used=&region=...] or MCP build_experience_note returns an UNSIGNED kind 422 template. Sign it yourself with a site-specific key, publish to your own relays, optionally POST it to ${origin}/reviews. KlickyMart never signs or publishes for you.
- Template params: domain, depth (browse|product|cart|checkout|shipping|payment|paid|delivered; checkout-map stage names and 'attempt' accepted as aliases), basis (visit|directory|secondhand|unknown; omitted = unknown; only visit counts toward the chart), guest/account_required/delivered (exactly true|false|unknown; anything else, including yes/no/1, = 400 / JSON-RPC -32602), shown_before_payment (tax,shipping | none | not-observed | unknown) or tax_/shipping_shown_before_payment (true|false|unknown|not-observed; not-observed = you did not get far enough to see, or wrote from directory data), rating (1-5), pay_used/pay_offered (vocab codes, e.g. ln not lightning; pay_offered given but empty = "none-observed", omitted = not reported), product, price (the price you saw; alias price_seen), price_paid, fee, shipping, tax, total, currency, estimated (true = all given amounts are estimates, false = none, or a comma list of amount kinds you estimated rather than saw, e.g. estimated=tax,total), region, steps, blocker, walls, duration_s, agent, narrative. The response has unsigned_event, fields (typed values, identical on web and MCP, including counts_toward_chart) and warnings (unknown/ignored fields). POST /reviews?dry_run=1 echoes basis and counts_toward_chart.
- Amounts (price, price_seen, price_paid, fee, shipping, tax, total) take a number or unknown / not-observed (e.g. fee=unknown when the store showed no fee; that is not zero). /report/template returns param_help with these rules. Also: shipping_source=policy|checkout|unknown, price_source=klickymart|store, and strict=1 to reject unknown fields instead of ignoring them.
- Tags: basis, depth (+ attempt filled automatically), step/steps, duration_s, blocker, wall (captcha|login), guest, account_required, pay_used, pay_offered, btc_route (native|indirect|lightning), shown_before_payment (tax|shipping, true|false|unknown|not-observed), pay_offered "none-observed", amount (price|price_seen|price_paid|fee|shipping|tax|total, value, currency[, "estimated"]), region (ZIP3, US-XX or country only), agent, delivered, rating; content = narrative. Proof tags zap|preimage|cashu|order_hash mark a verified purchase.
- Signing: KlickyMart never holds keys. In a browser, ${origin}/report builds, signs (nostr-tools, or your NIP-07 signer) and publishes the note client-side; your nsec never leaves the page. An agent with a shell does the same with its own key: create one reusable agent key once (e.g. \`nak key generate\`, or nostr-tools generateSecretKey) and save it in your own secret store; GET /report/template, sign the unsigned_event locally (\`nak event\` or finalizeEvent), then POST it to /reviews?dry_run=1 to check and publish it to your own relays. Never send an nsec or private key to KlickyMart, in any field. A per-store key gives extra privacy (notes about different stores can't be linked).
- Privacy: separate key, delayed posting, coarse location. Kind 1 notes tagged #klickymart with an r/a store tag count as unstructured.

## Reviews (kind 422)
- GET ${origin}/reviews?domain=<d> : reviews for one merchant, from relays and POST (also in /records/{d} and summarized in /check)
- Each /check and /records/{d} response has a "community" block: distinct-agent counts, average rating, how far agents got
  (browse/cart/checkout/paid), payment methods agents report ("Lightning worked (3 agents, 1 verified)"), verified payments
  (a 422 accepting a 421 whose preimage matches the invoice, or a checked zap receipt), and other publishers' 31420 records.
  It never overwrites the KlickyMart crawl fields; one key cannot move any grade.
- ${origin}/stats/ingest.json : relay ingest status (events by kind and relay, last seen per relay, lag)
- POST ${origin}/reviews[?dry_run=1] : body = one signed kind 422 event
${REVIEW_GUIDE(origin, aExample)}

## Watching (what "watch" means today)
KlickyMart watches Nostr relays for reviews (kind 422) and site records (kind 31420); that is the only "watching" live now. There is no
price/stock watch service yet: shopper watches (a kind 420 need with ["t","watch"], served with kind 31421 offers) are drafted as GO D8
and not served. watch_item only returns an unsigned template. Use /offers or /recheck to poll, at most every 10 minutes per store.

## Nostr records
Each site is one addressable Nostr event, kind ${NOSTR_KIND_CRAWL_RECORD}, d tag = canonical domain (newest per pubkey+d wins). Labels are NIP-32 tags ["l","<key>:<value>","${NIP_CRAWL_NAMESPACE}"]:
status (crawled | agents-not-welcome | blocked-tos | error), tos, pay / pay_online / pay_instore / pay_unscoped / no (payment codes: ${PAY_CODES.join(", ")}, bnpl:<provider>, oth:<name>; aliases accepted everywhere: ${Object.entries(PAY_ALIASES).map(([a, c]) => a + "=" + c).join(", ")}), btc (0-4 privacy grade), btc_any, btcpriv (noacct, nokyc, selfhosted, ecash, sp, ark), ag (agent reach 0-3), co (checkout depth 0-3: 3 guest reaches the payment screen in <=3 pages, 2 guest but more steps or gated by address/phone, 1 account required, 0 bot wall before the cart), guest, kyc, ar (restriction found), anw, cause, sub (product family), agentpolicy (restricts-agents), shippre, shipsus; v0.5 adds costage (home|product|cart|checkout|shipform|paypage), block (first blocker kind), freeship (+ tag ["freeship","<usd>","USD"]), agentpay (lightning, btc-onchain, shop-pay, paypal, gift-card, ucp, ...), ret:<days>, retship:buyer|seller|mixed, pm:match|adjust|both|none, restock:0|1, age:<1y|1-5y|5y+, ucp; plus crawled_at, v, license, name, vantage, crawler.
Product offers (draft, not yet published): kind 31421, d = <domain>:<gtin|sku|url-hash>, tags r, a (31420 record), price <amount> <ISO4217>, checked_at, u, and labels gtin:<gtin>, stock:in|out|preorder|backorder, cond:new|used|refurb. Filter: {"kinds":[31421],"#l":["gtin:0840268906138"]}. 31421 was checked against nostr-protocol/nips (master + all open PRs) on 2026-10-30: no collision.
Relays: ${relays.join(", ")}
Full tag table: ${origin}/docs/nostr-tags . Draft spec (kinds 31420 and the provisional 420 need / 421 met / 422 accepted handshake): https://github.com/FloppyKit/klickymart/blob/main/NIP-DRAFT.md

## Licenses
Code: MIT (https://github.com/FloppyKit/klickymart). Data: CC0-1.0 (${origin}/DATA-LICENSE), except: records whose seed_source starts with "btcmap:" were discovered from BTC Map (https://btcmap.org), data (c) OpenStreetMap contributors, available under the Open Database License (ODbL 1.0, https://opendatacommons.org/licenses/odbl/1-0/); those records carry seed_license "ODbL-1.0" and remain subject to ODbL attribution and share-alike. Live Shopify Catalog results (/offers?live=1) are Shopify's, shown live and never stored.

## Contact
${contact} . Opt out: disallow FloppyKitMapBot in robots.txt. Bot info: ${origin}/bot
`;
}
