# CASCADE: build plan (v0.1, 2026-10-29)

Home: FloppyKit GitHub org. This is the map and merchant directory for the everything-wallet PWA, and it replaces the earlier Square merchant-data plan.
Size: S ≤ 2 h, M ≤ 1 day, L ≤ 3 days of agent/build time (rough).
Who: **Matt**, **Plan** (planning bot), **Build** (build bot / cloud agent), **Crawl** (crawler run).

## Guardrails (apply to every GO)
- No public posting, no making repos public, no contacting anyone without Matt's explicit OK.
- Crawls: no logins, no account creation, no orders, no captcha solving, no fingerprint spoofing, honest user agent, stop at walls and log them (`ar`).
- This project runs on a dedicated server or in the cloud only.
- Cheap models: Flash-class for scoring and extraction; bigger models only for spec and QA review.
- Every fact in a record carries an evidence URL; unknowns stay null / TO-CONFIRM.

## P0: Go public with the idea
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 0.1 | Approve byline + repo link | SPIRAL-ISSUE.md | filled placeholders | Matt signs off on text | S | none | Matt |
| 0.2 | Create FloppyKit repo with spec docs only (NIP-DRAFT, CRAWL-RUBRIC, README, CASCADE); no pilot raw data or names | docs | private repo | contents reviewed | S | none | Build → Matt reviews |
| 0.3 | Make repo public | 0.2 | public URL | Matt's OK recorded | S | 0.2 | Matt |
| 0.4 | Post issue + 2-line pointer in Discussion #1 | 0.1, 0.3 | issue # | issue live, pointer links it | S | 0.1, 0.3 | Matt |

## P1: Spec freeze
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 1.1 | NIP-XX v0.3: fold in pilot lessons, credibility-weighted reputation, payment-proof tiers | NIP-DRAFT.md | NIP-DRAFT v0.3 | re-check kind 420/421/422/31420 collisions vs nips README + open PRs (grep PR diffs, authenticated) | M | none | Plan |
| 1.2 | Rubric v0.3 + JSON Schema for records | CRAWL-RUBRIC v0.2, pilot | rubric v0.3, `record.schema.json` | all 11 pilot records validate | S | none | Build |
| 1.3 | Terms-of-service read for ~200 sites | SITE-LIST | `tos` per site (`ok`/`bans-automation` + quote + URL) | 10 % hand spot-check agrees | M | 1.2 | Crawl (Flash) + Plan QA |
| 1.4 | CRAWLER-POLICY.md: respect rules, report restrictions, contact + opt-out path | README policy | policy doc + public bot info page text | Matt approves | S | none | Plan → Matt |
| 1.5 | Freeze site list against a public ranking | SITE-LIST, ranking source TO-CONFIRM | SITE-LIST v1 (source + date) | ~200 rows, source cited, no invented numbers | S | Matt picks source | Plan |

## P2: Browser-crawler harness
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 2.1 | Pick browser (see evaluation below) | sources | decision note | Matt OK | S | none | Plan → Matt |
| 2.2 | Harness: Playwright + Chromium, honest UA + bot info URL, robots parser, per-site budget (≤10 pages, ≥2 s spacing), screenshots + HAR hashes, `ar` detection, hard stop at login/payment-entry fields | 1.2, 1.4, 2.1 | `crawler/` | unit tests: robots disallow honored; a page with a captcha produces `cap!` and stops; no form submits beyond add-to-cart | L | 1.2, 1.4, 2.1 | Build |
| 2.3 | Extraction: rendered text → `pay`, `pay_no`, `kyc`, `btc` via Flash-class model with quoted evidence | 2.2 | extractor | on pilot pages, zero payment methods without a quote | M | 2.2 | Build |
| 2.4 | Calibrate: re-run 11 pilot sites | 2.2, 2.3 | records v0.3 + diff vs curl pilot | differences explained; `hl` and `co` filled where allowed | M | 2.3 | Crawl + Plan review |
| 2.5 | (optional) Web Bot Auth signing key + key directory, register as signed bot | 2.2 | signed requests | verification passes on a test zone | M | 2.2, Matt OK | Build |

## P3: Full crawl
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 3.1 | Crawl ~200 sites in batches of 25 | 1.5, 2.4 | `records.jsonl` + evidence store | every site has a record (blocked = record) | L | 2.4 | Crawl |
| 3.2 | QA: schema validation, null audit, outliers | 3.1 | QA report | 0 schema errors; every `pay` item quoted | S | 3.1 | Build |
| 3.3 | Hand spot-checks (10 % + all `btc≥3`) | 3.2 | corrections log | ≥95 % agreement, TO-CONFIRM threshold | M | 3.2 | Matt or Plan, reviewed by Matt |

## P4: Nostr publishing
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 4.1 | Crawler npub via NIP-46 signer (bunker on box/cloud; no nsec in env) | none | crawler npub + bunker | sign/verify round-trip; key never written to repo | S | Matt picks signer | Build |
| 4.2 | Own relay (strfry or khatru; write policy: only crawler + claimed business keys may publish 31420) | none | relay URL | rejects other pubkeys' 31420 | M | none | Build |
| 4.3 | Publish kind 31420 records; mirror to N public relays (list TO-CONFIRM) | 3.3, 4.1, 4.2 | events | all records fetchable by `#d` from own + ≥2 public relays | S | 3.3, 4.1, 4.2, **Matt OK (public)** | Build |
| 4.4 | Claim/dispute path: business proves NIP-05 on its domain, then publishes a self-record or dispute event; we re-crawl within N days | NIP-XX | docs + handler | test domain claim works end-to-end | M | 4.3 | Build + Plan |

## P5: Aggregator site (Cloudflare)
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 5.1 | Ingest worker: relay → D1 (bitmask columns) + KV cache | 4.3 | ingest pipeline | record count in D1 == relay | M | 4.3 | Build |
| 5.2 | Agent API `GET /q` + NDJSON export | 5.1 | Worker | p50 filter time <10 ms in-Worker (measured, not assumed) | M | 5.1 | Build |
| 5.3 | MCP endpoint (search_merchants, get_record) | 5.2 | MCP server | works from one MCP client test | S | 5.2 | Build |
| 5.4 | Human chart view (Pages): filterable table, grade colors, evidence links | 5.2 | site | loads <1 s on mobile; every cell links evidence | M | 5.2 | Build |
| 5.5 | Launch | 5.4 | public site | **Matt OK** | S | 5.4 | Matt |

## P6: Handshake + reputation
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 6.1 | Reference lib: build/verify 420/421/422 (nostr-tools) | NIP v0.3 | package | tests: valid loop, wrong-author 422 rejected | M | 1.1 | Build |
| 6.2 | Payment proof verifiers: zap receipt, preimage vs bolt11, nutzap | 6.1 | verifiers | test vectors pass | M | 6.1 | Build |
| 6.3 | Reputation indexer: count every paid loop, store source account + proof type, weight by account credibility (age, WoT, distinct counterparties) | 6.2 | indexer + published weights (NIP-85) | wash-loop fixture scores below honest fixture | L | 6.2 | Build + Plan |
| 6.4 | Demo loop on testnet/signet or small mainnet sats | 6.3 | recorded loop | loop visible in aggregator | S | 6.3, Matt OK for spend | Build |

## P7: Wallet hook + schedule
| GO | goal | inputs | output | acceptance | size | deps | who |
|---|---|---|---|---|---|---|---|
| 7.1 | Directory feed for the everything-wallet PWA (NDJSON + MCP + relay subscription) | 5.2 | feed spec + client snippet | PWA renders "pay here with Lightning" list from feed | M | 5.2 | Build |
| 7.2 | Re-crawl schedule (monthly full, weekly for `btc≥2` and disputed) via cron Worker / cloud | 3.1 | schedule | diff report per run | S | 3.1 | Build |
| 7.3 | Change log: publish grade/restriction movements | 7.2 | monthly digest | Matt reviews before any public post | S | 7.2 | Plan |

**Total: 30 GOs** (P0 4, P1 5, P2 5, P3 3, P4 4, P5 5, P6 4, P7 3).

## Browser evaluation (GO 2.1 input)
| option | fit | notes / sources |
|---|---|---|
| BrowserOS (browseros-ai/BrowserOS, AGPL-3.0, Chromium + MCP server, 53+ tools) | partial | Built around agents using your real logins ("Import your logins from Chrome", "Anything that needs a logged-in browser"), which is the opposite of our no-login policy. A desktop app with session replay; good for supervised spot-checks in a clean profile. Configurable honest UA and headless batch runs TO-CONFIRM. Sources: github.com/browseros-ai/BrowserOS, docs.browseros.com/browseros, server README in that repo. |
| Playwright + Chromium (self-run, box/cloud) | **recommended** for the crawler of record | Full control of UA, rate limits, robots enforcement and evidence capture; headful or headless; same engine as BrowserOS. Optional Web Bot Auth signing for cryptographic honesty (developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/). |
| Cloudflare Browser Run (Browser Rendering) | good second | Requests always carry non-removable `cf-brapi-*` headers and Web Bot Auth signatures; the crawl endpoint UA is `CloudflareBrowserRenderingCrawler/1.0`. Transparent by design, and it fits the Workers stack. But Cloudflare notes Browser Rendering itself doesn't qualify as a verified bot. Source: developers.cloudflare.com/browser-run/reference/automatic-request-headers/, blog.cloudflare.com/signed-agents/. |

Recommendation: Playwright on box/cloud as the crawler of record. Use BrowserOS (clean profile, no imported logins) for Matt's hand spot-checks, and Cloudflare Browser Run as a cross-check. Two different honest clients reporting the same wall make the restriction data stronger.

## Decisions Matt still owes
1. Byline for the issue and posts (name / PsychArts / FloppyKit).
2. OK to create and make the FloppyKit repo public (spec docs only) and the repo name (TO-CONFIRM).
3. Ranking source for the ~200-site list (Similarweb / Semrush / Tranco).
4. Sites whose terms ban automation: skip entirely, or record restriction-only from robots-allowed public pages?
5. Crawler contact identity: UA contact URL/email and bot info page location.
6. NIP-46 signer choice and where it runs; which public relays to mirror to.
7. Whether to use Web Bot Auth / register as a verified bot (2.5).
8. Spot-check reviewer and agreement threshold (3.3).
9. Model budget cap per crawl run (TO-CONFIRM $).
10. Whether to name merchants publicly at P4/P5 (records name domains by design).
