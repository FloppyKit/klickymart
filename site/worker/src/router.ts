import { WALLET_GUIDE } from "./wallet";
import { cashuMints, findReceipt, getInvoice, loadNutzaps, nutzapInfoOf, nwcRelays, type InvoiceInput } from "./tip-rails";
import { handleLnurlForward } from "./lnurl-forward";
import { APP_RELAYS, authSecret, checkFeedList, clearCookie, login, makeChallenge, parseFeedParams, readFeed, readSession, sessionCookie, tipReadyFor, TIP_LIMITS } from "./nostr-app";
const TEMPLATE_HELP = {
  estimated: "true (all amounts you give are estimates) | false (none) | comma list of amount kinds: price,price_seen,price_paid,fee,shipping,tax,total",
  shipping_source: "policy | checkout | unknown (where the shipping figure came from)",
  price_source: "klickymart | store (copied from KlickyMart data, or read on the store page)",
  strict: "1 = reject unknown fields with a 400 instead of ignoring them with a warning",
  amounts: "price, price_seen, price_paid, fee, shipping, tax, total: a non-negative number, or unknown / not-observed when the store did not show it (not zero)",
};
import { flagSummary, readFlagCache, refreshFlagCache, buildFlagStatic, FLAG_RULES, submitReport, inStoreOnly } from "./flags";
import { facilitate, facilitationEnabled, FACILITATION_PAUSED_BODY, markFacilitatedHistory, FACILITATE_LIMITS, FACILITATE_NOTE, FACILITATOR_NPUB, FACILITATOR_PUBKEY, type FacilitateInput } from "./facilitate";
import { curators, loadTips, perReviewer, summarize, TIP_BONUS_RULES } from "./tips";
import { mcpToolsList } from "./mcp";
import { addKnownBrands } from "./product-quality";
import { experienceTemplate, loadAggregates, parseExperience, storeExperience } from "./experience";
import { buildChart } from "./chart";
import { checkExtras, checkoutOf } from "./explain";
import type { Snapshot } from "./index-mem";
import { rowsToSnapshot, snapshotFromJson } from "./index-mem";
import { normalize } from "./normalize";
import { ingestFromNdjsonText, persistIngest } from "./ingest";
import { clearAgentNative, mergeAgentNative } from "./agent-native";
import { querySnapshot, validateQueryParams } from "./query";
import { rowToCompact, computeStats, parseRaw, suggestDomains } from "./records-api";
import { buildOpenApi, createMcpHandler, parseMcpRequest } from "./mcp";
import { fetchNostrJson, validateClaimDomain, hexToNpub } from "./claim";
import { licenseMetaBlock, licenseResponseHeaders } from "./license-meta";
import { buildKlickymartWellKnown, buildNostrWellKnown } from "./agent-capabilities";
import { buildSummaryJson } from "./summary-json";
import { buildLlmsTxt } from "./llms";
import { checkDomain } from "./check";
import { findAlternatives } from "./alternatives";
import { SELFTEST_DOMAIN } from "./experience";
import { hostOf } from "./store-card";
import { zipToState } from "./landed";
import { annotate, applyProductFilters, dedupe, CONDITIONS, CONDITION_FILTERS, PRODUCT_TYPES } from "./product-quality";
import { flagPriceOutliers, flagRow } from "./row-flags";
import { liveItems, findOffers, parseOffers, type OfferQuery } from "./offers";
import { landedFor, validZip, ZIP_ERROR } from "./landed";
import { recheck } from "./recheck";
import { liveCatalogSearch } from "./ucp-live";
import { getCommunity, ingestStats } from "./community";
import { relayList, checkProof, bindProof, type Ev } from "./relay-ingest";
import { storeBindings } from "./pay-binding";
import { take, takeAll } from "./ratelimit";
import { getReviews, parseReviewEvent, rateLimitCheck, storeReview, REVIEW_LIMITS } from "./reviews";
import { crawlerPubkeyHexFromSnapshot } from "./crawler-pubkey";
import { NOSTR_KIND_CRAWL_RECORD as K31420 } from "./nostr-kinds";
import { agentStats, recordAgentVisit, visitsToday } from "./agent-visits";
import { buildPageShell, isPreviewDataMode } from "./render/page-shell";
import { landscapeFromSnapshot, landscapeFormulaInputs } from "./landscape-metrics";
import { NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";
import { handleDnsClaim, claimStatus } from "./dns-claim";
import { setQueueStatus } from "./submissions";
import { computeTrustTiers, exportQueue, getSubmission, meetsMinTrust, parseSuggestionEvent, queuedStatus, submitStore, tierBadgeHtml, tierFields, TIERS, TRUST_RULES, type SubmitInput, type TrustInfo } from "./submissions";
import {
  renderHome,
  renderDashboard,
  renderMerchant,
  render404,
  renderAbout,
  renderClaim,
  renderContribute,
  renderDocsApi,
  renderDocsNostrTags,
  renderDocsRelayFilters,
  renderQueryResults,
  renderCheckResult,
  renderAlternatives,
  renderChart, renderReport, renderWallet, REPORT_RELAYS,
  renderApp,
} from "./render/pages";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  SITE_ORIGIN: string;
  SNAPSHOT_TTL_S: string;
  CONTACT: string;
  INGEST_TOKEN?: string;
  FIXTURE_NDJSON?: string;
  USE_TEST_FIXTURES?: string;
  PREVIEW_DATA?: string;
  RELAY_URLS?: string;
  CRAWLER_PUBKEY_HEX?: string;
  INGESTER?: DurableObjectNamespace;
  FACILITATOR_SK_HEX?: string;
  FACILITATE_ENABLED?: string;
  /** Salt for submission rate-limit hashes (wrangler secret). */
  SUBMIT_SALT?: string;
  /** HMAC key for login challenges and session cookies (wrangler secret); falls back to SUBMIT_SALT. Unset -> login 503. */
  AUTH_SECRET?: string;
  /** Value-for-value Lightning address for the site footer. Unset -> slot hidden. */
  SITE_TIP_LUD16?: string;
  /** Comma list of Cashu mint origins the /app page may reach (CSP). Unset -> DEFAULT_CASHU_MINTS. */
  CASHU_MINTS?: string;
  /** Comma list of wss:// relays a browser NWC connection may use (CSP). Unset -> DEFAULT_NWC_RELAYS. */
  NWC_RELAYS?: string;
  /** Upstream Lightning address that zap@<site> forwards to (wrangler var, e.g. name@primal.net). Unset -> 404. */
  LNURL_FORWARD_ZAP?: string;
}

/** JSON-RPC error for a thrown tool/handler error: bad input -> -32602 (not retryable), anything else -> -32603 with a retry hint. */
export class InputError extends Error {}
export function mcpErrorFor(e: unknown, id: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const bad = e instanceof InputError || /^invalid |must be|required|unknown /i.test(msg);
  return { jsonrpc: "2.0", id: id ?? null, error: bad
    ? { code: -32602, message: msg, data: { retryable: false, hint: "fix the arguments; see /llms.txt or tools/list for accepted values" } }
    : { code: -32603, message: "internal error: " + msg.slice(0, 200), data: { retryable: true, retry_after_s: 2 } } };
}
let cachedSnap: Snapshot | null = null;
let metaCheckedAt = 0;
let cachedMetaVersion = "";
/** Snapshot built from the data embedded in this deploy; immutable for the isolate's life, so build it once. */
let embeddedSnap: Snapshot | null = null;

export async function loadSnapshot(env: Env): Promise<Snapshot> {
  const now = Date.now();
  const ttl = parseInt(env.SNAPSHOT_TTL_S ?? "60", 10) * 1000;
  if (cachedSnap && now - metaCheckedAt < ttl) return cachedSnap;
  metaCheckedAt = now;

  if (env.KV) {
    const metaRaw = await env.KV.get("meta");
    const snapRaw = await env.KV.get("snap:current");
    if (snapRaw && metaRaw !== cachedMetaVersion) {
      cachedSnap = snapshotFromJson(snapRaw);
      cachedMetaVersion = metaRaw ?? cachedSnap.version;
      return cachedSnap;
    }
    if (cachedSnap && snapRaw) return cachedSnap;
  }

  if (env.DB) {
    try {
      const { results } = await env.DB.prepare("SELECT raw_json FROM records ORDER BY d").all<{ raw_json: string }>();
      if (results?.length) {
        const list = [];
        for (const r of results) {
          const raw = JSON.parse(r.raw_json) as Record<string, unknown>;
          const n = normalize(raw, "d1", 0);
          if (n.ok) list.push(n.row);
        }
        const preview = isPreviewDataMode(env);
        const hasExample = list.some((row) => row.d.includes(".example"));
        if (!preview && hasExample) {
          /* local D1 polluted with synthetic fixtures — use embedded production map */
        } else if (list.length > 0) {
          const verRow = await env.DB.prepare("SELECT v FROM meta WHERE k='version'").first<{ v: string }>();
          const srcRow = await env.DB.prepare("SELECT v FROM meta WHERE k='source'").first<{ v: string }>();
          cachedSnap = rowsToSnapshot(list, verRow?.v ?? "d1", srcRow?.v ?? "d1");
          return cachedSnap;
        }
      }
    } catch {
      /* D1 empty or migrations pending — fall through */
    }
  }

  if (env.FIXTURE_NDJSON && env.USE_TEST_FIXTURES === "1") {
    const { rows, report } = await ingestFromNdjsonText(env.FIXTURE_NDJSON, {
      allowSynthetic: true,
      sourceLabel: "fixture-ndjson",
    });
    cachedSnap = rowsToSnapshot([...rows.values()], report.version, report.source);
    return cachedSnap;
  }

  if (isPreviewDataMode(env)) {
    const { EMBEDDED_SYNTHETIC_NDJSON } = await import("./fixture-data");
    if (EMBEDDED_SYNTHETIC_NDJSON) {
      const { rows, report } = await ingestFromNdjsonText(EMBEDDED_SYNTHETIC_NDJSON, {
        allowSynthetic: true,
        sourceLabel: "preview-synthetic",
      });
      cachedSnap = rowsToSnapshot([...rows.values()], report.version, report.source);
      return cachedSnap;
    }
  }

  if (embeddedSnap) { cachedSnap = embeddedSnap; return cachedSnap; }
  const { EMBEDDED_EVENTS_NDJSON, EMBEDDED_RECORDS_FALLBACK_NDJSON, EMBEDDED_EVENTS_VERIFIED_AT_BUILD } = await import("./fixture-data");
  if (EMBEDDED_EVENTS_NDJSON) {
    const { rows, report } = await ingestFromNdjsonText(EMBEDDED_EVENTS_NDJSON, {
      allowSynthetic: false,
      // Signatures were checked by scripts/embed-fixtures.js at build; re-verifying 300+ Schnorr sigs per cold start hit CPU limits (1102).
      verifyEvents: !EMBEDDED_EVENTS_VERIFIED_AT_BUILD,
      sourceLabel: "nostr-31420-ndjson",
      contentHash: "events-v1",
    });
    const { EMBEDDED_AGENT_NATIVE_NDJSON } = await import("./fixture-data");
    if (rows.size > 0 && EMBEDDED_AGENT_NATIVE_NDJSON) {
      const an = await ingestFromNdjsonText(EMBEDDED_AGENT_NATIVE_NDJSON, { allowSynthetic: false, verifyEvents: !EMBEDDED_EVENTS_VERIFIED_AT_BUILD, sourceLabel: "nostr-31420-agent-native" });
      clearAgentNative();
      mergeAgentNative(rows, an.rows);
    }
    if (rows.size > 0) {
      cachedSnap = embeddedSnap = rowsToSnapshot([...rows.values()], report.version, report.source);
      return cachedSnap;
    }
  }

  if (EMBEDDED_RECORDS_FALLBACK_NDJSON) {
    const { rows, report } = await ingestFromNdjsonText(EMBEDDED_RECORDS_FALLBACK_NDJSON, {
      allowSynthetic: false,
      sourceLabel: "records-fallback",
      contentHash: "records-v1",
    });
    cachedSnap = rowsToSnapshot([...rows.values()], report.version, report.source);
    return cachedSnap;
  }

  const { EMBEDDED_FIXTURE_NDJSON } = await import("./fixture-data");
  if (EMBEDDED_FIXTURE_NDJSON) {
    const { rows, report } = await ingestFromNdjsonText(EMBEDDED_FIXTURE_NDJSON, {
      allowSynthetic: false,
      verifyEvents: true,
      sourceLabel: "embedded-legacy",
    });
    cachedSnap = rowsToSnapshot([...rows.values()], report.version, report.source);
    return cachedSnap;
  }

  cachedSnap = { version: "empty", source: "none", rows: [], meta: { version: "empty", source: "none", count: 0, ts_min: 0, ts_max: 0 } };
  return cachedSnap;
}

export function resetSnapshotCache(): void {
  cachedSnap = null;
  embeddedSnap = null;
  metaCheckedAt = 0;
  cachedMetaVersion = "";
}

function apiHeaders(version: string, filterMs: number): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "X-KM-Snapshot": version,
    "X-KM-Filter-Ms": filterMs.toFixed(3),
    "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
    ...licenseResponseHeaders(),
  };
}

function err400(param: string, message: string): Response {
  return Response.json({ error: { code: "bad_param", message, param } }, { status: 400 });
}

async function submitReview(env: Env, snap: Snapshot, body: unknown, dryRun: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const known = new Set([...snap.rows.map((r) => r.d), SELFTEST_DOMAIN]);
  const p = parseReviewEvent(body, (d) => known.has(d));
  const x = parseExperience(body, (d) => known.has(d));
  if (env.DB && (p.ok || x.ok)) {
    const ev0 = body as Ev;
    try {
      const tb = await env.DB.prepare("SELECT pubkey FROM tombstones WHERE id = ? AND pubkey = ?").bind(ev0.id, ev0.pubkey).first<{ pubkey: string }>(); // KM-010
      if (tb) return { status: 410, body: { ok: false, error: { code: "deleted", message: "this event was deleted by its author (NIP-09) and cannot be resubmitted" } } };
    } catch { /* migration pending */ }
  }
  if (!p.ok && !x.ok) return { status: 400, body: { ok: false, error: { code: x.code === "not_an_experience" || x.code === "bad_kind" ? p.code : x.code, message: x.code === "not_an_experience" || x.code === "bad_kind" ? p.message : x.message } } };
  if (!p.ok && x.ok) {
    // Structured shopping-experience 422 (or #klickymart kind 1) without the legacy review tags
    if (!env.DB) return { status: 503, body: { ok: false, error: { code: "no_db", message: "storage unavailable" } } };
    if (dryRun) return { status: 200, body: { ok: true, dry_run: true, id: x.value.id, d: x.value.d, structured: x.value.structured, basis: x.value.basis, counts_toward_chart: x.value.basis === "visit", ...(x.value.basis === "visit" ? {} : { chart_note: `basis "${x.value.basis}": kept and shown with the store, but only basis=visit notes count toward the chart` }), stored: false, warnings: x.value.warnings } };
    try {
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM experiences WHERE pubkey = ? AND received_day = ?").bind(x.value.pubkey, new Date().toISOString().slice(0, 10)).first<{ n: number }>();
      if ((n?.n ?? 0) >= REVIEW_LIMITS.perPubkeyPerDay) return { status: 429, body: { ok: false, error: { code: "rate_limited", message: `max ${REVIEW_LIMITS.perPubkeyPerDay} notes per key per day` } } };
      if (!(await env.DB.prepare("SELECT 1 FROM experiences WHERE id = ?").bind(x.value.id).first())
        && await exTake(env.DB, x.value.id, x.value.pubkey)) // KM-008, R5-003
        return { status: 429, body: { ok: false, error: { code: "rate_limited", message: `max ${REVIEW_LIMITS.perPubkeyPerDay} notes per key per day` } } };
      const st = await storeExperience(env.DB, x.value, body, { source: "post" });
      if (st === "stored") await refreshFlagCache(env.DB, await buildFlagStatic(snap));
      return { status: st === "stored" ? 201 : 200, body: { ok: true, id: x.value.id, d: x.value.d, structured: x.value.structured, basis: x.value.basis, counts_toward_chart: x.value.basis === "visit", stored: st === "stored", duplicate: st === "duplicate", chart_url: "/chart", warnings: x.value.warnings } };
    } catch { return { status: 503, body: { ok: false, error: { code: "storage_error", message: "experience storage not ready" } } }; }
  }
  if (!p.ok) return { status: 400, body: { ok: false, error: { code: p.code, message: p.message } } };
  if (!env.DB) return { status: 503, body: { ok: false, error: { code: "no_db", message: "storage unavailable" } } };
  try {
    const rl = await rateLimitCheck(env.DB, p.value);
    if (rl) return { status: 429, body: { ok: false, error: rl } };
    const xb = x.ok ? { structured: x.value.structured, basis: x.value.basis, counts_toward_chart: x.value.basis === "visit", ...(x.value.basis === "visit" ? {} : { chart_note: `basis "${x.value.basis}": kept and shown with the store, but only basis=visit notes count toward the chart` }), warnings: x.value.warnings } : {};
    if (dryRun) return { status: 200, body: { ok: true, dry_run: true, id: p.value.id, d: p.value.d, stored: false, ...xb } };
    let proof_status: string | null = null;
    if (p.value.fulfillment || p.value.proof) {
      const get = async (id?: string | null) => { if (!id) return null; const r = await env.DB.prepare("SELECT raw_json FROM nostr_events WHERE id = ?").bind(id).first<{ raw_json: string }>(); return r ? (JSON.parse(r.raw_json) as Ev) : null; };
      const ev = body as Ev;
      try { proof_status = checkProof(ev, await get(p.value.fulfillment), await get(ev.tags.find((t) => t[0] === "zap")?.[1]), await storeBindings(env.DB, p.value.d), p.value.d); proof_status = await bindProof(env.DB, proof_status, ev, Math.floor(Date.now() / 1000)); } catch { proof_status = "unverified-claim"; }
    }
    const st = await storeReview(env.DB, p.value, body, Date.now(), { source: "post", proof_status });
    if (x.ok) { try { await storeExperience(env.DB, x.value, body, { source: "post", proof_status }); } catch { /* migration pending */ } }
    await markFacilitatedHistory(env.DB, p.value.d);
    await refreshFlagCache(env.DB, await buildFlagStatic(snap));
    return { status: st === "stored" ? 201 : 200, body: { ok: true, id: p.value.id, d: p.value.d, stored: st === "stored", duplicate: st === "duplicate", review_url: `/merchant/${p.value.d}#reviews`, ...xb } };
  } catch {
    return { status: 503, body: { ok: false, error: { code: "storage_error", message: "reviews storage not ready" } } };
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = env.SITE_ORIGIN || `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  }

  await recordAgentVisit(env.DB, path, request.headers.get("User-Agent"));

  const snap = await loadSnapshot(env);
  const shell = buildPageShell(snap, env, url);
  const accept0 = request.headers.get("Accept") ?? "";
  if (request.method === "GET" && (accept0.includes("text/html") || !accept0) && !path.includes(".")) {
    shell.agentVisitsToday = await visitsToday(env.DB);
  }

  const crawlerHex = crawlerPubkeyHexFromSnapshot(snap, env.CRAWLER_PUBKEY_HEX);
  const aTagFor = (d: string) => (crawlerHex ? `${K31420}:${crawlerHex}:${d}` : null);

  const tiersFor = async (ds: string[]): Promise<Map<string, TrustInfo>> => {
    const rawBy = new Map(snap.rows.map((r) => [r.d, r]));
    return computeTrustTiers(env.DB, ds, (d) => { const r = rawBy.get(d); return r ? parseRaw(r.raw_json) : null; });
  };
  const allTiers = () => tiersFor(snap.rows.map((r) => r.d));
  /** min_trust filters the snapshot BEFORE paging, so total/next stay correct. */
  const trustSnap = async (minTrust: string | null): Promise<Snapshot> => {
    if (!minTrust) return snap;
    const t = await allTiers();
    return { ...snap, rows: snap.rows.filter((r) => meetsMinTrust(t.get(r.d)?.trust_tier, minTrust)) };
  };
  const submitCtx = (via: "post" | "mcp" | "nostr", dryRun: boolean) => ({ db: env.DB, indexed: new Set(snap.rows.map((r) => r.d)), salt: env.SUBMIT_SALT ?? "", ip: request.headers.get("cf-connecting-ip"), via, dryRun, origin });
  const handleSubmit = async (body: Record<string, unknown>, via: "post" | "mcp", dryRun: boolean) => {
    const evIn = body.event ?? (typeof body.kind === "number" ? body : null);
    if (evIn) {
      if (Array.isArray((evIn as { tags?: unknown }).tags) && ((evIn as { tags: unknown[][] }).tags).some((t) => Array.isArray(t) && t[0] === "claim")) return { status: 400, body: { ok: false, status: "rejected", reason: "claim events go to POST /claim/dns", error: { code: "use_claim_endpoint", message: "claim events go to POST /claim/dns" } } };
      const p = parseSuggestionEvent(evIn);
      if (!p.ok) return { status: 400, body: { ok: false, status: "rejected", reason: p.message, error: { code: p.code, message: p.message } } };
      return submitStore(body as SubmitInput, { ...submitCtx(via, dryRun), via: "nostr", signed: p.value });
    }
    return submitStore(body as SubmitInput, submitCtx(via, dryRun));
  };

  if (path === "/submit" && request.method === "POST") {
    const text = await request.text();
    if (text.length > 16384) return Response.json({ ok: false, error: { code: "too_large", message: "body too large" } }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ ok: false, error: { code: "bad_json", message: "body must be JSON: {domain, category?, note?, evidence_url?, submitter?: {agent_name?}} or a signed kind 1423 event" } }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ ok: false, error: { code: "bad_json", message: "body must be a JSON object" } }, { status: 400 });
    const r = await handleSubmit(body as Record<string, unknown>, "post", url.searchParams.get("dry_run") === "1" || (body as { dry_run?: unknown }).dry_run === true);
    return Response.json(r.body, { status: r.status, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", ...(r.status === 429 ? { "Retry-After": "3600" } : {}) } });
  }
  const qs = path.match(/^\/submit\/queue\/([^/]+)\/status$/);
  if (qs && request.method === "POST") {
    if (!env.INGEST_TOKEN) return Response.json({ ok: false, error: { code: "disabled", message: "queue status updates are not enabled" } }, { status: 404 });
    if (request.headers.get("Authorization") !== `Bearer ${env.INGEST_TOKEN}`) return Response.json({ ok: false, error: { code: "unauthorized", message: "Bearer token required" } }, { status: 401 });
    let b: { status?: unknown; reason?: unknown };
    try { b = await request.json(); } catch { return Response.json({ ok: false, error: { code: "bad_json", message: "body must be JSON {status, reason?}" } }, { status: 400 }); }
    const r = await setQueueStatus(env.DB, decodeURIComponent(qs[1]!), b.status, b.reason, url.searchParams.get("dry_run") === "1");
    return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/claim/dns" && request.method === "POST") {
    let b: unknown;
    const raw = await request.text();
    if (raw.length > 8192) return Response.json({ ok: false, error: { code: "too_large", message: "body too large" } }, { status: 413 });
    try { b = JSON.parse(raw); } catch { return Response.json({ ok: false, error: { code: "bad_json", message: "body must be JSON: {event} (signed kind 1423 with [\"claim\",\"dns\"|\"revoke\"]) or {domain} to re-check" } }, { status: 400 }); }
    if (!b || typeof b !== "object") return Response.json({ ok: false, error: { code: "bad_json", message: "body must be a JSON object" } }, { status: 400 });
    const r = await handleDnsClaim(env.DB, b as Record<string, unknown>, { dryRun: url.searchParams.get("dry_run") === "1" });
    return Response.json(r.body, { status: r.status, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }
  if (path === "/claim/dns" && request.method === "GET") {
    const d = (url.searchParams.get("domain") ?? "").toLowerCase().replace(/^www\./, "");
    if (!d) return Response.json({ how: "1) Add a TXT record at _klickymart.<domain> containing your npub (bare, or klickymart-claim=npub1...). 2) POST /claim/dns {event} with a kind 1423 you signed: tags [[\"r\", <domain>], [\"claim\", \"dns\"]]. Revoke with [\"claim\", \"revoke\"] signed by the same key. POST {domain} re-checks the TXT; if it is gone the claim becomes dns-removed. ?dry_run=1 validates without storing." }, { headers: { "Access-Control-Allow-Origin": "*" } });
    return Response.json({ domain: d, claims: await claimStatus(env.DB, d) }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }
  if ((path === "/submit/queue.ndjson" || path === "/submit/queue.json") && request.method === "GET") {
    const st = url.searchParams.get("state") ?? "pending";
    if (!["pending", "review", "crawled", "refused", "error"].includes(st)) return err400("state", "state is pending | review | crawled | refused | error");
    const items = await exportQueue(env.DB, { state: st, since: Number(url.searchParams.get("since") ?? 0) || 0, limit: Number(url.searchParams.get("limit") ?? 500) || 500 });
    if (path.endsWith(".ndjson")) return new Response(items.map((x) => JSON.stringify(x)).join("\n") + (items.length ? "\n" : ""), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Count": String(items.length), ...(items.length ? {} : { "X-KM-Empty-OK": "1" }) } });
    return Response.json({ ...licenseMetaBlock(), count: items.length, state: st, items, note: "Community-submitted domains waiting for the gated crawl (run on the KlickyMart box via crawler/gate.py, never from the Worker). Submitters only gave a domain, a category hint and a note." }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (path === "/submit" && request.method === "GET") {
    return Response.json({ ...licenseMetaBlock(), how: "POST /submit {domain, category?, note?, evidence_url?, submitter?: {agent_name?}} (add ?dry_run=1 to validate without storing), MCP submit_store, or publish a signed kind 1423 note with [\"r\", domain], [\"t\", category] and optional [\"proof\", url] tags.", kind: 1423, statuses: ["queued", "duplicate", "rejected"], tiers: TIERS, trust_rules: TRUST_RULES, queue: `${origin}/submit/queue.json` }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  if (path.startsWith("/submit/") && request.method === "GET") {
    const id = decodeURIComponent(path.slice("/submit/".length));
    const r = /^(sub_[0-9a-f]{20}|[0-9a-f]{64})$/.test(id) ? await getSubmission(env.DB, id, origin) : null;
    if (!r) return Response.json({ error: { code: "not_found", message: "no submission with that id" } }, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    return Response.json({ ...licenseMetaBlock(), ...r }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }

  if (path === "/reviews" && request.method === "POST") {
    const text = await request.text();
    if (text.length > REVIEW_LIMITS.maxBytes) return Response.json({ ok: false, error: { code: "too_large", message: "event too large" } }, { status: 413 });
    let ev: unknown;
    try { ev = JSON.parse(text); } catch { return Response.json({ ok: false, error: { code: "bad_json", message: "body must be JSON" } }, { status: 400 }); }
    const dry = url.searchParams.get("dry_run") === "1";
    const r = await submitReview(env, snap, ev, dry);
    return Response.json(r.body, { status: r.status, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/facilitate" && request.method === "POST" && !facilitationEnabled(env)) {
    return Response.json(FACILITATION_PAUSED_BODY, { status: 503, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }
  if (path === "/facilitate" && request.method === "GET" && !facilitationEnabled(env)) {
    return Response.json({ ...FACILITATION_PAUSED_BODY, facilitator_npub: FACILITATOR_NPUB }, { status: 503, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }
  if (path === "/facilitate" && request.method === "POST") {
    const text = await request.text();
    if (text.length > REVIEW_LIMITS.maxBytes) return Response.json({ ok: false, error: { code: "too_large", message: "body too large" } }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ ok: false, error: { code: "bad_json", message: "body must be JSON" } }, { status: 400 }); }
    const known = new Set([...snap.rows.map((r) => r.d), SELFTEST_DOMAIN]);
    const r = await facilitate(env, (body ?? {}) as FacilitateInput, (d) => known.has(d), request.headers.get("cf-connecting-ip") ?? "unknown");
    return Response.json(r.body, { status: r.status, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }
  if (path === "/facilitate" && request.method === "GET") {
    return Response.json({ facilitator_npub: FACILITATOR_NPUB, facilitator_pubkey: FACILITATOR_PUBKEY, limits: FACILITATE_LIMITS, note: FACILITATE_NOTE,
      usage: "POST JSON {domain, agent_pubkey, need_id?, proof:{type:'preimage',preimage,bolt11}|{type:'zap',receipt}|{type:'hash',sha256}}. Returns a signed 421 for you to publish. Refused once the store has claimed its listing." });
  }
  if (path === "/app" && request.method === "GET") {
    return new Response(renderApp(origin, shell, { mints: cashuMints(env), nwcRelays: nwcRelays(env) }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; connect-src 'self' ${[...new Set([...APP_RELAYS, ...nwcRelays(env), ...cashuMints(env)])].join(" ")}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'` } });
  }
  if (path === "/auth/challenge" && request.method === "GET") {
    const sec = authSecret(env);
    if (!sec) return Response.json({ ok: false, error: { code: "auth_disabled", message: "login is not configured on this deployment" } }, { status: 503, headers: { "Cache-Control": "no-store" } });
    return Response.json({ ok: true, challenge: makeChallenge(sec), kind: 27235, u: `${origin}/auth/login`, method: "POST", expires_in_s: 120, note: "Sign a kind 27235 event with tags [u, method, challenge] and POST {event} to /auth/login. Never send a key." }, { headers: { "Cache-Control": "no-store" } });
  }
  const sameOrigin = () => { const o = request.headers.get("Origin"); return !o || o === origin || o === `${url.protocol}//${url.host}`; };
  if ((path === "/auth/login" || path === "/auth/logout") && request.method === "POST" && !sameOrigin()) {
    return Response.json({ ok: false, error: { code: "cross_origin", message: "login and logout are same-origin only" } }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/auth/login" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const r = await login(env.DB, body, { origin, secret: authSecret(env), ip: request.headers.get("cf-connecting-ip") });
    const h = new Headers({ "Cache-Control": "no-store" });
    if (r.cookie) h.set("Set-Cookie", sessionCookie(r.cookie, url.protocol === "https:"));
    return Response.json(r.body, { status: r.status, headers: h });
  }
  if (path === "/auth/me" && request.method === "GET") {
    return Response.json({ pubkey: readSession(authSecret(env), request.headers.get("Cookie")) }, { headers: { "Cache-Control": "no-store" } });
  }
  if (path === "/auth/logout" && request.method === "POST") {
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": clearCookie(url.protocol === "https:") } });
  }
  if (path === "/feed.json" && request.method === "GET") {
    const f = parseFeedParams(url.searchParams);
    if (!f.ok) return err400("filter", f.message);
    const extra = snap.rows.map((r) => { try { const e = JSON.parse(r.raw_json) as { sig?: string }; return e && typeof e.sig === "string" ? e : null; } catch { return null; } }).filter(Boolean) as never[];
    const items = await readFeed(env.DB, f.value, extra);
    return Response.json({ ...licenseMetaBlock(), count: items.length, items, verified: true, source: "klickymart-d1-index" }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30", "X-KM-Empty-OK": "1" } });
  }
  if (path === "/feed/list-check" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const r = await checkFeedList(env.DB, body, { salt: env.SUBMIT_SALT ?? "", ip: request.headers.get("cf-connecting-ip") });
    return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (path === "/tip-ready.json" && request.method === "GET") {
    const pks = [...new Set((url.searchParams.get("pubkeys") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean))];
    if (!pks.length || pks.length > TIP_LIMITS.maxPubkeys || pks.some((p) => !/^[0-9a-f]{64}$/.test(p))) return err400("pubkeys", `1 to ${TIP_LIMITS.maxPubkeys} comma-separated 64-hex pubkeys`);
    const ln = await tipReadyFor(env.DB, pks, { salt: env.SUBMIT_SALT ?? "", ip: request.headers.get("cf-connecting-ip") });
    const allowed = new Set(cashuMints(env));
    const items = await Promise.all(ln.map(async (t) => {
      const c = await nutzapInfoOf(env.DB, t.pubkey);
      const cashu = c ? { mints: c.mints, relays: c.relays, p2pk: c.p2pk, info_id: c.id, mints_reachable_here: c.mints.filter((m) => allowed.has(m)) } : null;
      return { ...t, tip_ready: t.tip_ready || !!cashu, rails: { lightning: t.tip_ready, cashu: !!cashu }, lightning: t.tip_ready ? { addr: t.addr } : null, cashu, ranking_weight: 0 as const };
    }));
    return Response.json({ items, note: "Display only: tip-ready never adds ranking weight. KlickyMart never holds keys or funds.", wallet: `${origin}/wallet#tip-ready` }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
  }
  if (path.startsWith("/.well-known/lnurlp/") && request.method === "GET") {
    const r = await handleLnurlForward(path, url, env, origin, request.headers.get("cf-connecting-ip"), env.SUBMIT_SALT ?? "");
    if (r) return r;
  }
  if (path === "/tip/invoice" && request.method === "POST") {
    const body = await request.json().catch(() => null) as InvoiceInput | null;
    const r = await getInvoice(env.DB, body ?? {}, { salt: env.SUBMIT_SALT ?? "", ip: request.headers.get("cf-connecting-ip") });
    return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (path === "/tip/receipt" && request.method === "GET") {
    const id = (url.searchParams.get("zap_request") ?? "").toLowerCase(); const zapper = url.searchParams.get("zapper")?.toLowerCase() ?? null;
    if (!/^[0-9a-f]{64}$/.test(id) || (zapper && !/^[0-9a-f]{64}$/.test(zapper))) return err400("zap_request", "zap_request (and optional zapper) must be 64-hex");
    return Response.json(await findReceipt(env.DB, id, zapper), { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
  if (path === "/tip/nutzaps.json" && request.method === "GET") {
    const ids = (url.searchParams.get("e") ?? "").toLowerCase().split(",").filter(Boolean);
    if (!ids.length || ids.length > 100 || ids.some((x) => !/^[0-9a-f]{64}$/.test(x))) return err400("e", "1 to 100 comma-separated 64-hex event ids");
    const m = await loadNutzaps(env.DB, ids);
    return Response.json({ items: [...m].map(([id, l]) => ({ id, nutzaps: l })), note: "Display only; never ranking weight. Only nutzaps P2PK-locked to the recipient's 10019 key at a mint in that 10019 are listed. sats are always claimed: mint signatures are not checked." }, { headers: { "Cache-Control": "public, max-age=30", "Access-Control-Allow-Origin": "*" } });
  }
  if (path === "/wallet" && request.method === "GET") {
    return new Response(renderWallet(origin, shell), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
  }
  if (path === "/wallet.json" && request.method === "GET") return Response.json({ ...licenseMetaBlock(), ...WALLET_GUIDE }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
  if (path === "/flags.json" && request.method === "GET") {
    const d = url.searchParams.get("domain")?.toLowerCase() || undefined;
    const flags = [...(await readFlagCache(env.DB, d)).values()].filter((f) => f.reasons.length);
    return Response.json({ ...licenseMetaBlock(), domain: d ?? null, ...flagSummary(flags), items: flags.map((f) => ({ ...f, label: `flagged (${f.level}): ${f.reasons.map((r) => r.detail).join("; ")}` })),
      rules: FLAG_RULES, appeal: "Authors can reply to the note with context (we read replies as context) or delete it with NIP-09. Flags never hide or delete a note.",
      report: `POST ${origin}/flag with a signed NIP-56 kind 1984 event: ["e", <note id>, <reason>]` }, { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "public, max-age=60" } });
  }
  if (path === "/flag" && request.method === "POST") {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ ok: false, error: { code: "too_large", message: "report too large" } }, { status: 413 });
    let ev: Ev; try { ev = JSON.parse(text); } catch { return Response.json({ ok: false, error: { code: "bad_json", message: "body must be a signed kind 1984 event" } }, { status: 400 }); }
    const r = await submitReport(env.DB, ev);
    if (r.status === 201) await refreshFlagCache(env.DB, await buildFlagStatic(snap));
    return Response.json(r.body, { status: r.status, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }
  if ((path === "/tips.json" || path === "/curators.json") && request.method === "GET") {
    const d = url.searchParams.get("domain")?.toLowerCase() || undefined;
    const t = await loadTips(env.DB, d);
    const body = path === "/curators.json"
      ? { curators: curators(t), note: "Curator record: who tipped which agent notes (public NIP-57 zap receipts). Self-zaps excluded." }
      : { domain: d ?? null, per_review: [...t.byNote].map(([id, x]) => ({ id, d: t.noteDomain.get(id) ?? null, author: t.author.get(id) ?? null, ...summarize(x) })), per_reviewer: perReviewer(t),
          weight_rule: "note weight x (1 + min(0.5, 0.1 x bonus tippers)); self-zaps ignored; flagged tip rings / tip-only keys add nothing",
          bonus_rules: { min_sats_per_zap: TIP_BONUS_RULES.MIN_SATS, tipper_history: `a visit note, other public activity we hold, or a key first seen ${TIP_BONUS_RULES.MIN_AGE_S / 86400}+ days ago`, distinct: "each tipper counts once per note", cap: "+50% per note at most", display: "every tip is shown (count, sats); only bonus tippers add weight" } };
    return Response.json({ ...licenseMetaBlock(), ...body }, { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "public, max-age=60" } });
  }

  if (path === "/reviews" && request.method === "GET") {
    const d = (url.searchParams.get("domain") ?? "").toLowerCase();
    if (!d) return err400("domain", "domain required");
    return Response.json({ ...licenseMetaBlock(), domain: d, a: aTagFor(d), reviews: await getReviews(env.DB, d) }, { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "public, max-age=30" } });
  }

  const altParams = (sp: URLSearchParams | Record<string, unknown>) => {
    const g = (k: string) => (sp instanceof URLSearchParams ? sp.get(k) : (sp[k] as string | undefined)) ?? undefined;
    const guest = g("guest");
    return { domain: g("domain") || undefined, category: g("category") || g("q") || undefined, sub: g("sub") || undefined, pay: g("pay") || undefined, guest: guest === "1" || guest === "true" || (guest as unknown) === true,
      include_indirect: ["1", "true"].includes(String(g("include_indirect") ?? g("btc_indirect") ?? "")) || (sp as Record<string, unknown>).include_indirect === true, limit: g("limit") ? Number(g("limit")) : undefined };
  };

  const addLanded = (body: { items: Record<string, unknown>[] }, zip: string, taxpreOnly = false) => {
    const byD = new Map(snap.rows.map((x) => [x.d, x]));
    for (const it of body.items) { const row = byD.get(String(it.d)); if (row) it.landed = landedFor(parseRaw(row.raw_json), zip); }
    if (taxpreOnly) {
      const tp = (it: Record<string, unknown>) => (it.landed as { tax_shown_before_payment?: boolean | null } | undefined)?.tax_shown_before_payment;
      const before = body.items;
      body.items = before.filter((it) => tp(it) === true);
      const unknown = before.filter((it) => tp(it) == null).length;
      const b = body as Record<string, unknown>;
      b.count = body.items.length; b.total = body.items.length;
      b.taxpre = { observed_true: body.items.length, observed_false: before.filter((it) => tp(it) === false).length, unknown,
        note: body.items.length ? "Only stores where our checkout probe saw sales tax before the payment step." : `No store in this list has been observed showing tax before payment; for ${unknown} of ${before.length} it is unknown (not observed), which does not mean they hide it.` };
    }
  };
  /** Unindexed live-catalog stores are queued for our normal crawl pipeline (robots → terms → public pages). Only the
   * domain + queue time is kept (our own list); no catalog product data is stored. */
  const markPending = async (items: Record<string, any>[]) => {
    const ds = [...new Set(items.filter((i) => i.store?.indexed === false && i.domain).map((i) => String(i.domain).replace(/^www\./, "")))];
    const st = new Map<string, { queued_at: string }>();
    for (const d of ds.slice(0, 30)) {
      let v: { queued_at: string } | null = null;
      try { v = env.KV ? await env.KV.get<{ queued_at: string }>(`pending:${d}`, "json") : null; } catch { /* KV optional */ }
      if (!v) { v = { queued_at: new Date().toISOString() }; try { await env.KV?.put(`pending:${d}`, JSON.stringify(v)); } catch { /* */ } }
      st.set(d, v);
    }
    for (const i of items) {
      const d = String(i.domain ?? "").replace(/^www\./, ""); const v = st.get(d);
      if (i.store?.indexed === false && v) i.store = { ...i.store, check: "pending check", queued_at: v.queued_at,
        note: "Store not indexed yet. It is queued for KlickyBot's normal check: robots.txt first, then the store's terms (if they ban automation we record that and stop), then public pages only (pay methods incl. Shop Pay/Link, guest checkout, shipping policy). Facts stay null until then." };
    }
  };
  /** Why a named store has no product rows (instead of a silent 0). */
  const coverageNote = (domain: string, live: boolean) => {
    const d = domain.toLowerCase().replace(/^www\./, "");
    const row = snap.rows.find((x) => x.d === d || x.d === `www.${d}`);
    const raw = row ? parseRaw(row.raw_json) : null;
    const fb = (raw?.checkout_map as { first_blocker?: { kind?: string; evidence?: string } } | undefined)?.first_blocker;
    const parts = [`0 products for ${d}.`];
    parts.push(row ? `KlickyMart indexes the store (co=${row.co ?? "unknown"}) but has no product offers for it: our offer crawler reads only public structured product data (schema.org JSON-LD or Shopify product JSON), and ${d}'s product pages did not expose readable structured prices to KlickyBot${fb?.kind === "network-error" ? ` (its site also reset our connections: ${fb.evidence ?? "network error"})` : ""}.` : `${d} is not in KlickyMart's index.`);
    parts.push(live ? `It is also absent from the live Shopify Catalog, which only covers Shopify stores; ${d} does not appear there.` : "Add live=1 to also search the live Shopify Catalog (Shopify stores only).");
    return parts.join(" ");
  };
  const offersFor = async (q: OfferQuery, live: boolean) => {
    const { EMBEDDED_OFFERS_NDJSON } = await import("./fixture-data");
    const allOffers = parseOffers(EMBEDDED_OFFERS_NDJSON || "");
    addKnownBrands(allOffers.map((o) => (o.b ?? "").split(/\s+/)[0] ?? "").filter((w) => w.length >= 3 && !/gift|card|the/i.test(w)));
    const r = findOffers(allOffers, snap, origin, q);
    if (r.ok && live && q.q) {
      // Page through the live catalog (bounded) until filters leave enough rows. Catalog also gets price/condition natively.
      const want = Math.min(q.limit ?? 10, 50), MAX_PAGES = 4;
      let cursor: string | undefined; let pages = 0, scanned = 0, totalCount: number | null = null;
      const products: unknown[] = []; let lv: { ok: boolean; results?: { products?: unknown[] } } & Record<string, unknown> = { ok: false };
      const cond = q.condition && !q.condition.split(",").includes("unknown") ? (q.condition.split(",").some((c) => c !== "new") ? q.condition.split(",").includes("new") ? undefined : ["secondhand"] : ["new"]) : undefined;
      do {
        lv = await liveCatalogSearch(q.q, q.zip ?? null, origin, fetch, q.domain, { maxMinor: q.max_price ? Math.round(q.max_price * 100) : undefined, condition: cond, cursor, pageSize: 25 }) as typeof lv;
        if (!lv.ok) break;
        pages++; const ps = lv.results?.products ?? []; scanned += ps.length; products.push(...ps);
        const pg = lv.pagination as { has_next_page?: boolean; cursor?: string; total_count?: number } | null;
        totalCount = pg?.total_count ?? totalCount; cursor = pg?.has_next_page ? pg.cursor : undefined;
        const kept = liveItems(products as Parameters<typeof liveItems>[0], snap, origin, q).items.length;
        if (kept >= want) break;
      } while (cursor && pages < MAX_PAGES);
      if (pages > 0) {
        const li = liveItems(products as Parameters<typeof liveItems>[0], snap, origin, q);
        const ann = li.items.map((x) => annotate(x, q.q));
        const rel = ann.filter((x) => !x.below_floor); const relDropped = ann.length - rel.length;
        const pf = applyProductFilters(dedupe(rel).rows, { condition: q.condition, type: q.type, brand_strict: q.brand_strict });
        lv = { ...lv, ok: true, items: pf.rows.slice(0, want), filters_applied_after_fetch: [...li.filters_applied_after_fetch, ...(q.condition ? [`condition=${q.condition}`] : []), ...(q.type ? [`type=${q.type}`] : [])],
          dropped_by_filters: li.dropped_by_filters + pf.dropped, dropped_below_relevance_floor: relDropped, condition_unknown_dropped: pf.condition_unknown_dropped, pages_scanned: pages, products_scanned: scanned, catalog_total: totalCount,
          filter_note: `Scanned ${scanned} live products over ${pages} page(s) (max ${MAX_PAGES}); KlickyMart applied ${[...li.filters_applied_after_fetch, ...(q.condition ? ["condition"] : []), ...(q.type ? ["type"] : [])].join(", ") || "no filters"} after fetching (dropped ${li.dropped_by_filters + pf.dropped}); ${relDropped} below the relevance floor (no query word in the title).${pf.rows.length === 0 ? " 0 matches in the scanned pages; this is not proof none exist, try a narrower query." : ""}` };
        delete lv.results; delete lv.pagination; // normalized items only; raw catalog payload is not re-served or stored
        await markPending(lv.items as Record<string, any>[]);
      }
      (r.body as Record<string, unknown>).live_shopify_catalog = lv;
    }
    if (r.ok && q.domain) {
      const b = r.body as { items: unknown[]; live_shopify_catalog?: { items?: unknown[] } };
      if (!b.items.length && !(b.live_shopify_catalog?.items ?? []).length) (r.body as Record<string, unknown>).coverage_note = coverageNote(q.domain, live && !!q.q);
    }
    return r;
  };
  const offerQuery = (g: (k: string) => string | null | undefined): OfferQuery | string => {
    const zip = g("zip"); if (zip && !validZip(zip)) return ZIP_ERROR;
    const cnd = g("condition"); if (cnd && !cnd.split(",").every((c) => (CONDITION_FILTERS as readonly string[]).includes(c))) return `condition must be one or more of ${CONDITION_FILTERS.join(", ")} (unknown = condition not stated or inferable)`;
    const ty = g("type"); if (ty && !ty.split(",").every((c) => (PRODUCT_TYPES as readonly string[]).includes(c))) return `type must be one or more of ${PRODUCT_TYPES.join(", ")}`;
    const mp = g("max_price");
    return { gtin: g("gtin") || undefined, mpn: g("mpn") || undefined, q: g("q") || undefined, domain: g("domain") || undefined, zip: zip || null,
      in_stock: g("in_stock") === "1" || g("in_stock") === "true", max_price: mp ? Number(mp) : undefined, limit: g("limit") ? Number(g("limit")) : undefined,
      condition: g("condition") || undefined, type: g("type") || undefined, brand_strict: g("brand_strict") === "1" || g("brand_strict") === "true" };
  };

  /** One call: a product's landed price at a ZIP across indexed offers (+ live Shopify Catalog with live=1), store facts on every row. */
  const landedCall = async (g: (k: string) => string | null | undefined) => {
    const zip = g("zip");
    if (!zip) return { ok: false as const, param: "zip", message: "zip=<5-digit US ZIP> is required" };
    if (!validZip(zip)) return { ok: false as const, param: "zip", message: ZIP_ERROR };
    const url = g("url");
    const q0 = offerQuery(g);
    if (typeof q0 === "string") return { ok: false as const, param: "zip", message: q0 };
    const q: OfferQuery = { ...q0, zip, ...(url && !q0.q && !q0.gtin && !q0.mpn ? { domain: hostOf(url) } : {}), limit: Math.min(q0.limit ?? 20, 50) };
    const live = g("live") === "1" || g("live") === "true";
    const r = await offersFor(q, live && !!q.q);
    if (!r.ok) return { ok: false as const, param: "q", message: r.message };
    const b = r.body as { items: Record<string, any>[]; live_shopify_catalog?: { items?: Record<string, any>[]; filter_note?: string; ok?: boolean; error?: string } };
    let rows: Record<string, any>[] = [...b.items.map((i) => ({ source: "klickymart-observed", ...i })), ...(b.live_shopify_catalog?.items ?? [])];
    if (url) { const m = rows.filter((i) => String(i.url ?? "").split("?")[0] === url.split("?")[0]); if (m.length) rows = m; }
    const before = rows.length;
    const pf = applyProductFilters(rows.map((i) => (i.source === "klickymart-observed" ? annotate(i, q.q) : i)), { condition: q.condition, type: q.type, brand_strict: q.brand_strict });
    const dd = dedupe(pf.rows); rows = dd.rows;
    const outliers = flagPriceOutliers(rows);
    const tier = new Map(rows.map((i) => [i, flagRow(i, { usZip: !!(q.zip && validZip(String(q.zip))) })]));
    const key = (i: Record<string, any>) => [tier.get(i)! * 10 + (i.brand_match === "lookalike" ? 2 : 0) + (i.landed?.est_total == null ? 1 : 0), i.landed?.est_total ?? i.price ?? 1e9];
    rows.sort((x, y) => { const a = key(x), c = key(y); return a[0] - c[0] || a[1] - c[1]; });
    const blocked = rows.filter((i) => i.agent_usable === false).length;
    const lvb = b.live_shopify_catalog as Record<string, any> | undefined;
    const condUnknown = pf.condition_unknown_dropped + Number(lvb?.condition_unknown_dropped ?? 0);
    return { ok: true as const, body: { query: { ...q, live }, zip, state: zipToState(zip), count: rows.length, items: rows,
      ranking: "stores an agent can use first (agent_usable true: our probe confirmed add-to-cart or reached the payment step), then stores not checked or not confirmed yet, then stores that may not ship to the US (with a US ZIP), then price outliers, then stores an agent must not use (blocked-tos, agents-not-welcome, error) last; within each, rows with a known landed total first (cheapest first), then by item price; brand look-alikes (e.g. 'B0SE') after their group. est_total is null unless price, shipping and tax are all known",
      agent_usable_note: "Every row has agent_usable (true / false / null = store not checked yet), store_status and flags[]. Rows with agent_usable=false are listed so you know they exist, not as options.",
      not_usable_rows: blocked, price_outliers: outliers,
      deduped: dd.removed, dropped_by_product_filters: pf.dropped, scanned_rows: before,
      ...(q.condition ? { condition_unknown_dropped: condUnknown, ...(condUnknown && !q.condition.split(",").includes("unknown") ? { condition_hint: `${condUnknown} row(s) with condition not stated were left out; add ",unknown" (e.g. condition=${q.condition},unknown) to include them` } : {}) } : {}),
      ...(lvb && lvb.pages_scanned !== undefined ? { pages_scanned: lvb.pages_scanned, products_scanned: lvb.products_scanned, dropped_below_relevance_floor: lvb.dropped_below_relevance_floor ?? 0 } : {}),
      ...(rows.length === 0 && q.domain ? { coverage_note: coverageNote(q.domain, live) } : {}),
      ...(b.live_shopify_catalog ? { live: { ok: b.live_shopify_catalog.ok, error: b.live_shopify_catalog.error, filter_note: b.live_shopify_catalog.filter_note, pages_scanned: lvb?.pages_scanned ?? null, products_scanned: lvb?.products_scanned ?? null, source: "Results from Shopify Catalog (live, not cached or stored by KlickyMart)" } } : {}) } };
  };
  if ((path === "/chart.json" || path === "/chart") && request.method === "GET") {
    const aggs = await loadAggregates(env.DB, undefined, Date.now(), { inStoreOnly: inStoreOnly(snap) });
    const ch = buildChart(snap, aggs, { limit: Number(url.searchParams.get("limit") ?? 50) || 50, category: url.searchParams.get("category") ?? undefined });
    if (path === "/chart") return new Response(renderChart(origin, shell, ch), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    const st = aggs.get(SELFTEST_DOMAIN);
    const tch = await allTiers();
    for (const it of ch.items as unknown as Record<string, unknown>[]) Object.assign(it, tierFields(tch.get(String(it.d ?? it.domain ?? ""))));
    return Response.json({ ...licenseMetaBlock(), count: ch.items.length, method: ch.method, community_stores: aggs.size, flags: { flagged_notes: [...aggs.values()].reduce((a, x) => a + (x.flags?.flagged_notes ?? 0), 0), url: `${origin}/flags.json` }, items: ch.items, ...(st ? { selftest: { d: SELFTEST_DOMAIN, note: "KlickyMart ingest self-test (fake .invalid domain); not ranked", community: st } } : {}) }, { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "public, max-age=60" } });
  }
  if (path === "/report/template" && request.method === "GET") {
    const args: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
    for (const k of ["pay_offered", "walls", "steps"]) if (typeof args[k] === "string") args[k] = String(args[k]).split(",");
    const d = String(args.domain ?? "").toLowerCase().replace(/^www\./, "");
    const t = experienceTemplate(args, aTagFor(d));
    if (!t.ok) return err400(t.code === "region_too_precise" ? "region" : t.code === "missing_domain" ? "domain" : t.code.replace(/^bad_/, ""), t.message);
    return Response.json({ ...t.value, param_help: TEMPLATE_HELP }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
  }
  if (path === "/report" && request.method === "GET") {
    const ex = experienceTemplate({ domain: "example.com", depth: "payment", guest: "true", account_required: "false", basis: "visit", pay_used: "ln", pay_offered: ["card", "ln", "spay"], btc_route: "native", shown_before_payment: "tax,shipping", price: "49.00", shipping: "0", tax: "4.27", total: "53.27", region: "660", duration_s: "95", steps: ["home", "product", "cart", "checkout", "payment"], agent: "my-agent/1.0", rating: "4", narrative: "Guest checkout reached payment in 5 steps; Lightning offered." }, aTagFor("example.com"));
    return new Response(renderReport(origin, shell, ex.ok ? JSON.stringify(ex.value.unsigned_event, null, 1) : ""), { headers: { "Content-Type": "text/html; charset=utf-8",
      // In-browser signing page: scripts only from this origin, network only to this origin and wss:// relays, no framing.
      // Strict: no inline script (none on this page, so no hashes needed); scripts only from this origin (the pinned,
      // SRI-checked nostr-tools bundle and km-report-sign.js); network only to this origin and the listed relays.
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; connect-src 'self' ${REPORT_RELAYS.join(" ")}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
      "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
  }
  if (path === "/pending.json" && request.method === "GET") {
    // Our own queue of store domains surfaced by live results that we haven't checked yet (domain + queue time only).
    const out: { domain: string; queued_at: string | null }[] = [];
    try {
      const l = env.KV ? await env.KV.list({ prefix: "pending:", limit: 1000 }) : { keys: [] as { name: string }[] };
      for (const k of l.keys) { const d = k.name.slice(8); if (!snap.rows.some((x) => x.d === d || x.d === `www.${d}`)) out.push({ domain: d, queued_at: ((await env.KV.get<{ queued_at: string }>(k.name, "json")) ?? { queued_at: null }).queued_at }); }
    } catch { /* KV optional */ }
    return Response.json({ count: out.length, items: out, note: "Store domains seen in live Shopify Catalog results that KlickyMart has not checked yet. KlickyBot checks them in order: robots.txt, then the store's terms (a ban is recorded as the fact and the store is not crawled), then public pages only. No catalog product data is kept." }, { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "no-store" } });
  }
  // Agent-observed shipping/tax from shopping-experience notes. Kept beside (never merged into) the crawl/policy figures.
  const attachObserved = async (body: Record<string, unknown>) => {
    const items = (body.items as Record<string, unknown>[] | undefined) ?? [];
    const ds = [...new Set(items.map((i) => String(i.d ?? i.domain ?? i.store ?? "")).filter(Boolean))].slice(0, 50);
    const aggs = ds.length ? await loadAggregates(env.DB, ds, Date.now(), { inStoreOnly: inStoreOnly(snap) }) : new Map();
    const obs: Record<string, unknown> = {};
    for (const [d, a] of aggs) obs[d] = { source: "observed by agents (Nostr kind 422 notes)", keys: a.keys, corroborated: a.corroborated, shipping_usd: a.observed.shipping_usd, tax_rate_pct: a.observed.tax_rate_pct, latest: a.latest_at };
    body.observed_by_agents = { note: "Separate from landed totals above, which come from KlickyMart's crawl and store policies. Corroborated means 2+ distinct keys.", stores: obs };
  };
  if (path === "/landed" && request.method === "GET") {
    const r = await landedCall((k) => url.searchParams.get(k));
    if (!r.ok) return err400(r.param, r.message);
    await attachObserved(r.body as Record<string, unknown>);
    return Response.json({ ...licenseMetaBlock(), ...r.body }, { headers: { ...apiHeaders(snap.version, 0), ...(url.searchParams.get("live") === "1" ? { "Cache-Control": "no-store" } : {}) } });
  }

  if (path === "/offers" && request.method === "GET") {
    const q = offerQuery((k) => url.searchParams.get(k));
    if (typeof q === "string") return err400("zip", q);
    const live = url.searchParams.get("live") === "1";
    const r = await offersFor(q, live);
    if (!r.ok) return err400("q", r.message);
    // Shopify Catalog results must never be cached or stored: live responses are no-store end to end.
    return Response.json({ ...licenseMetaBlock(), ...r.body }, { headers: { ...apiHeaders(snap.version, 0), ...(live ? { "Cache-Control": "no-store" } : {}) } });
  }

  if (path === "/recheck" && (request.method === "GET" || request.method === "POST")) {
    const d = (url.searchParams.get("domain") ?? "").trim().toLowerCase().replace(/^www\./, "");
    const row = snap.rows.find((x) => x.d === d || x.d === `www.${d}`);
    if (!row) return err400("domain", "recheck only works for domains already in the index");
    return Response.json(await recheck(env.DB, row.d, Math.floor(Date.now() / 1000)), { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "no-store" } });
  }

  if (path === "/alternatives" && request.method === "GET") {
    const taxpre = url.searchParams.get("taxpre") === "1";
    const azip = url.searchParams.get("zip");
    if (taxpre && azip === null) return err400("taxpre", "taxpre=1 needs zip=<5-digit US ZIP>");
    const ap = altParams(url.searchParams);
    const r = findAlternatives(snap, origin, taxpre ? { ...ap, limit: 500 } : ap);
    if (!r.ok) return err400("domain", r.message);
    if (azip !== null) {
      if (!validZip(azip)) return err400("zip", "zip must be a 5-digit US ZIP code");
      addLanded(r.body as { items: Record<string, unknown>[] }, azip, taxpre);
      if (taxpre) { const b = r.body as { items: unknown[]; count?: number }; b.items = b.items.slice(0, ap.limit ?? 20); b.count = b.items.length; }
    }
    if (url.searchParams.get("format") === "html") {
      return new Response(renderAlternatives(origin, r.body, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return Response.json({ ...licenseMetaBlock(), ...r.body }, { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/check" && request.method === "GET") {
    const many = url.searchParams.get("domains");
    if (many !== null) {
      // Batch: up to 10 stores in one call (e.g. a user's saved stores). Same facts as single /check, without alternatives.
      const ds = [...new Set(many.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];
      if (!ds.length || ds.length > 10) return err400("domains", "domains= takes 1 to 10 comma-separated store domains");
      const zipB = url.searchParams.get("zip");
      if (zipB !== null && !validZip(zipB)) return err400("zip", ZIP_ERROR);
      const items = ds.map((d) => {
        const c = checkDomain(snap, d, origin);
        if (!c.ok) return { domain: d, error: c.message };
        const row = snap.rows.find((r) => r.d === c.body.domain);
        if (zipB && row) c.body.landed = landedFor(parseRaw(row.raw_json), zipB);
        return c.body;
      });
      const tb = await tiersFor(items.map((x) => String((x as { domain?: unknown }).domain ?? "")));
      for (const x of items as Record<string, unknown>[]) if (!x.error && x.verdict !== "not-in-index") Object.assign(x, tierFields(tb.get(String(x.domain))));
      return Response.json({ ...licenseMetaBlock(), count: items.length, items }, { headers: apiHeaders(snap.version, 0) });
    }
    const res0 = checkDomain(snap, url.searchParams.get("domain") ?? "", origin);
    if (!res0.ok) return err400("domain", res0.message);
    const res = res0;
    const zipQ = url.searchParams.get("zip");
    if (zipQ !== null && !validZip(zipQ)) return err400("zip", "zip must be a 5-digit US ZIP code");
    if (zipQ && res.body.verdict !== "not-in-index") {
      const row = snap.rows.find((r) => r.d === res.body.domain);
      if (row) res.body.landed = landedFor(parseRaw(row.raw_json), zipQ);
    }
    if (res.body.verdict !== "not-in-index") {
      const rv = await getReviews(env.DB, String(res.body.domain), 0);
      if (res.body.verdict !== "reachable" || res.body.agent_ordering) {
        const alt = findAlternatives(snap, origin, { domain: String(res.body.domain), limit: 5 });
        if (alt.ok) res.body.alternatives = { categories: alt.body.categories, items: alt.body.items, more: `${origin}/alternatives?domain=${res.body.domain}` };
      }
      res.body.community = await getCommunity(env.DB, String(res.body.domain), crawlerHex, inStoreOnly(snap));
      const ex = (await loadAggregates(env.DB, [String(res.body.domain)], Date.now(), { inStoreOnly: inStoreOnly(snap) })).get(String(res.body.domain));
      res.body.community_experience = ex ? { ...ex, source: "Nostr shopping-experience notes", chart: `${origin}/chart`, flags_url: `${origin}/flags.json?domain=${res.body.domain}` } : { source: "Nostr shopping-experience notes", keys: 0, note: "No agent has posted a shopping-experience note for this store yet.", report: `${origin}/report` };
      res.body.reviews = { count: rv.count, avg_rating_5: rv.avg_rating_5, url: `${origin}/reviews?domain=${res.body.domain}`, review_a_tag: aTagFor(String(res.body.domain)) };
    }
    if (res.body.verdict !== "not-in-index") Object.assign(res.body, tierFields((await tiersFor([String(res.body.domain)])).get(String(res.body.domain))));
    else {
      const qs = await queuedStatus(env.DB, String(res.body.domain ?? url.searchParams.get("domain") ?? ""));
      if (qs.queued) Object.assign(res.body, { queued: true, trust_tier: "unverified", trust_label: "Unverified · community-submitted", src: "community", submission: `${origin}/submit/${qs.submission}`, crawl_state: qs.state });
      else res.body.submit = { hint: "Not indexed. To suggest it, POST /submit {domain} (or MCP submit_store). Nothing is submitted unless you ask.", url: `${origin}/submit` };
    }
    if (url.searchParams.get("format") === "html") {
      return new Response(renderCheckResult(origin, res.body, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return Response.json({ ...licenseMetaBlock(), ...res.body }, { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/stats/ingest.json" && request.method === "GET") {
    const body = await ingestStats(env.DB, crawlerHex, relayList(env.RELAY_URLS)) as Record<string, unknown>;
    if (env.INGESTER) {
      try { body.live = await (await env.INGESTER.get(env.INGESTER.idFromName("main")).fetch("https://ingester/status")).json(); } catch { body.live = null; }
    }
    body.note = "Live WebSocket subscriptions (Durable Object) plus a 5-minute since-based catch-up. Events are signature- and schema-checked; nothing about the sender's network is stored.";
    return Response.json(body, { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "no-store" } });
  }

  if (path === "/stats/agents.json" && request.method === "GET") {
    return Response.json(await agentStats(env.DB), { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "public, max-age=30" } });
  }

  if (path === "/q" && request.method === "GET") {
    const qsp = new URLSearchParams(url.searchParams); qsp.delete("min_trust");
    const validated = validateQueryParams(qsp);
    if (!validated.ok) return err400(validated.param, validated.message);
    const minTrust = url.searchParams.get("min_trust");
    if (minTrust && !(TIERS as readonly string[]).includes(minTrust)) return err400("min_trust", "min_trust is flagged | unverified | seen | verified");
    const result = querySnapshot(await trustSnap(minTrust), validated.params);
    const tq = await allTiers();
    const items = result.items.map((r) => ({ ...rowToCompact(r, origin), ...tierFields(tq.get(r.d)) }));
    const body = {
      ...licenseMetaBlock(),
      version: snap.version,
      total: result.total,
      count: result.count,
      next: result.next,
      filter_ms: result.filter_ms,
      items,
    };
    if (url.searchParams.get("format") === "ndjson") {
      const stream = new ReadableStream({
        start(controller) {
          for (const item of items) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(item) + "\n"));
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { ...apiHeaders(snap.version, result.filter_ms), "Content-Type": "application/x-ndjson" } });
    }
    const format = url.searchParams.get("format");
    const accept = request.headers.get("Accept") ?? "";
    const wantsHtml = format === "html" || (accept.includes("text/html") && format !== "json");
    if (wantsHtml) {
      return new Response(
        renderQueryResults(snap, origin, url.searchParams, result.items, result.total, shell),
        { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } },
      );
    }
    return Response.json(body, { headers: apiHeaders(snap.version, result.filter_ms) });
  }

  if (path === "/summary.json" && request.method === "GET") {
    const summary = buildSummaryJson(snap);
    return Response.json(summary, {
      headers: {
        ...apiHeaders(snap.version, 0),
        "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      },
    });
  }

  if (path.startsWith("/records/") && request.method === "GET") {
    const domain = decodeURIComponent(path.slice("/records/".length)).toLowerCase();
    const row = snap.rows.find((r) => r.d === domain);
    if (!row) {
      return Response.json(
        { error: { code: "not_found", message: "record not found" }, did_you_mean: suggestDomains(snap.rows, domain) },
        { status: 404, headers: apiHeaders(snap.version, 0) },
      );
    }
    const raw = parseRaw(row.raw_json);
    return Response.json(
      {
        ...licenseMetaBlock(),
        record: raw,
        derived: { ...rowToCompact(row, origin), ...tierFields((await tiersFor([domain])).get(domain)) },
        explain: { ...checkExtras(row, raw), checkout_depth: checkoutOf(row, raw) },
        nostr: { kind: NOSTR_KIND_CRAWL_RECORD, d: domain, event_id: null, a: aTagFor(domain) },
        reviews: await getReviews(env.DB, domain),
        community: await getCommunity(env.DB, domain, crawlerHex, inStoreOnly(snap)),
      },
      { headers: apiHeaders(snap.version, 0) },
    );
  }

  if (path.startsWith("/merchant/") && request.method === "GET") {
    const domain = decodeURIComponent(path.slice("/merchant/".length)).toLowerCase();
    const row = snap.rows.find((r) => r.d === domain);
    if (!row) return new Response(render404(origin, shell), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (request.headers.get("Accept")?.includes("text/html")) {
      const badge = tierBadgeHtml((await tiersFor([row.d])).get(row.d));
      const rvs = await getReviews(env.DB, domain);
      const tipped = await tippedFor(env.DB, domain, (rvs?.items ?? []).map((x) => x.id));
      return new Response(renderMerchant(row, origin, shell, rvs, aTagFor(domain), await getCommunity(env.DB, domain, crawlerHex, inStoreOnly(snap)), tipped).replace(H1_RE, (m) => spliceBadge(m, badge)), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    }
    return handleRequest(new Request(`${origin}/records/${domain}`, request), env);
  }

  if (path === "/export.ndjson" && request.method === "GET") {
    const validated = validateQueryParams(url.searchParams);
    if (!validated.ok) return err400(validated.param, validated.message);
    const probe = querySnapshot(snap, { ...validated.params, limit: 1 });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        let cursor: string | undefined;
        do {
          const page = querySnapshot(snap, { ...validated.params, limit: 500, cursor });
          for (const row of page.items) {
            controller.enqueue(encoder.encode(row.raw_json + "\n"));
          }
          cursor = page.next ?? undefined;
        } while (cursor);
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        ...apiHeaders(snap.version, probe.filter_ms),
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  if (path === "/stats" && request.method === "GET") {
    const stats = computeStats(snap.rows);
    const landscape = landscapeFromSnapshot(snap);
    const landscape_inputs = landscapeFormulaInputs(snap.rows);
    return Response.json(
      {
        ...licenseMetaBlock(),
        ...stats,
        landscape,
        landscape_inputs,
        preview_data: shell.previewData,
        version: snap.version,
        generated_at: new Date().toISOString(),
      },
      { headers: apiHeaders(snap.version, 0) },
    );
  }

  if (path === "/openapi.json") {
    return Response.json(buildOpenApi(origin), { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/llms.txt") {
    const relays = (env.RELAY_URLS ?? "").replace(/[\[\]"]/g, "").split(",").map((x) => x.trim()).filter(Boolean);
    return new Response(buildLlmsTxt(origin, env.CONTACT || "bot@klickymart.com", relays, aTagFor("example.com") ?? undefined), { headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/llms-full.txt") {
    const base = await (await handleRequest(new Request(`${origin}/llms.txt`), env)).text();
    return new Response(base + "\nRubric: see CRAWL-RUBRIC.md field table.\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (path === "/.well-known/klickymart.json") {
    const body = buildKlickymartWellKnown(origin, snap, {
      contact: env.CONTACT,
      relayUrlsRaw: env.RELAY_URLS,
      crawlerPubkeyHexEnv: env.CRAWLER_PUBKEY_HEX,
    });
    return Response.json(body, { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/.well-known/mcp.json") {
    return Response.json({ name: "KlickyMart", url: "/mcp", transport: "streamable-http (stateless, JSON responses only)", tools: (mcpToolsList({ facilitate: facilitationEnabled(env) }) as { tools: { name: string }[] }).tools.map((t) => t.name), llms_txt: "/llms.txt" }, { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/.well-known/nostr.json") {
    const body = buildNostrWellKnown(snap, env.CRAWLER_PUBKEY_HEX);
    return Response.json(body, { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/.well-known/ucp" || path === "/ucp/agent-profile.json") {
    // UCP platform (agent) profile for read-only catalog access. KlickyMart never creates carts or checkouts via UCP.
    const v = "2026-08-25";
    const cap = (n: string) => [{ version: v, spec: `https://ucp.dev/${v}/specification/shopping/catalog/`, schema: `https://ucp.dev/${v}/schemas/shopping/${n}.json` }];
    return Response.json({ ucp: { version: v, services: {}, capabilities: { "dev.ucp.shopping.catalog.search": cap("catalog_search"), "dev.ucp.shopping.catalog.lookup": cap("catalog_lookup") }, payment_handlers: {} },
      name: "KlickyMart (KlickyBot)", contact: "bot@klickymart.com", info: `${origin}/bot`, use: "read-only product lookup; results are not cached or stored" },
      { headers: { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" } });
  }
  if (path === "/robots.txt") {
    return new Response(`# Agents: start at ${origin}/llms.txt (endpoints, MCP, record schema). About: ${origin}/about\nUser-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`, { headers: { "Content-Type": "text/plain" } });
  }

  if (path === "/sitemap.xml") {
    const urls = snap.rows.map((r) => `<url><loc>${origin}/merchant/${escXml(r.d)}</loc></url>`).join("");
    return new Response(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, { headers: { "Content-Type": "application/xml" } });
  }

  if (path === "/mcp" && request.method === "GET") {
    return new Response("MCP endpoint: POST JSON-RPC here (stateless Streamable HTTP, JSON responses; no SSE stream).", { status: 405, headers: { Allow: "POST, OPTIONS", "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/mcp" && request.method === "POST") {
    const body = await request.text();
    const parsed = parseMcpRequest(body);
    if (!parsed) return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null });
    if (parsed.isNotification) return new Response(null, { status: 202, headers: { "Access-Control-Allow-Origin": "*" } });
    const handler = createMcpHandler({
      runQuery: async (sp0) => {
        const minTrust = sp0.get("min_trust"); const sp = new URLSearchParams(sp0); sp.delete("min_trust");
        if (minTrust && !(TIERS as readonly string[]).includes(minTrust)) throw new InputError("min_trust: must be flagged | unverified | seen | verified");
        const v = validateQueryParams(sp);
        if (!v.ok) throw new InputError(`${v.param}: ${v.message}`);
        const result = querySnapshot(await trustSnap(minTrust), v.params);
        const tq = await allTiers();
        const items = result.items.map((r) => ({ ...rowToCompact(r, origin), ...tierFields(tq.get(r.d)) }));
        return { body: { version: snap.version, total: result.total, count: result.count, items, filter_ms: result.filter_ms }, filter_ms: result.filter_ms };
      },
      checkDomain: async (domain) => { const r = checkDomain(snap, domain, origin); if (r.ok && r.body.verdict !== "not-in-index") Object.assign(r.body, tierFields((await tiersFor([String(r.body.domain)])).get(String(r.body.domain)))); return r; },
      findAlternatives: async (args) => {
        const r = findAlternatives(snap, origin, altParams(args));
        const z = args.zip ? String(args.zip) : null;
        if (r.ok && z && validZip(z)) addLanded(r.body as { items: Record<string, unknown>[] }, z, args.taxpre === true || args.taxpre === 1);
        return r;
      },
      buildExperienceNote: (args) => { const d = String(args.domain ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]; return experienceTemplate(args, aTagFor(d)); },
      landedPrice: async (args) => {
        const r = await landedCall((k) => (args[k] === undefined || args[k] === null ? null : k === "live" ? (args[k] === true || args[k] === "1" ? "1" : null) : String(args[k])));
        return r.ok ? r : { ok: false as const, message: `${r.param}: ${r.message}` };
      },
      findOffers: async (args) => {
        const q = offerQuery((k) => (args[k] === undefined || args[k] === null ? null : String(args[k])));
        if (typeof q === "string") return { ok: false as const, message: q };
        return offersFor(q, args.live === true);
      },
      getCheckoutMap: async (domain) => {
        const row = snap.rows.find((r) => r.d === domain.toLowerCase() || r.d === `www.${domain.toLowerCase()}`);
        if (!row) return null;
        const raw = parseRaw(row.raw_json);
        return { domain: row.d, checkout_depth: checkoutOf(row, raw), checkout_map: checkExtras(row, raw).checkout_map, landed_cost: checkExtras(row, raw).landed_cost };
      },
      recheckDomain: async (domain) => {
        const d = domain.toLowerCase().replace(/^www\./, "");
        const row = snap.rows.find((x) => x.d === d || x.d === `www.${d}`);
        if (!row) return { error: "recheck only works for domains already in the index" };
        return recheck(env.DB, row.d, Math.floor(Date.now() / 1000));
      },
      checkDomainZip: async (domain, zip) => {
        const r = checkDomain(snap, domain, origin);
        if (r.ok && zip && validZip(zip)) { const row = snap.rows.find((x) => x.d === r.body.domain); if (row) r.body.landed = landedFor(parseRaw(row.raw_json), zip); }
        return r;
      },
      submitReview: async (event, dryRun) => submitReview(env, snap, event, dryRun),
      submitStore: async (args: Record<string, unknown>) => handleSubmit({ ...args, submitter: args.agent_name ? { agent_name: args.agent_name } : (args.submitter as never) }, "mcp", args.dry_run === true),
      facilitate: !facilitationEnabled(env) ? undefined : async (args) => { const known = new Set([...snap.rows.map((r) => r.d), SELFTEST_DOMAIN]); return facilitate(env, args as FacilitateInput, (d) => known.has(d), request.headers.get("cf-connecting-ip") ?? "mcp"); },
      getReviews: async (domain) => ({ domain, a: aTagFor(domain.toLowerCase()), reviews: await getReviews(env.DB, domain.toLowerCase()), community: await getCommunity(env.DB, domain.toLowerCase(), crawlerHex, inStoreOnly(snap)) }),
      getRecord: async (domain) => {
        const row = snap.rows.find((r) => r.d === domain.toLowerCase());
        if (!row) return null;
        return { body: { record: parseRaw(row.raw_json), derived: rowToCompact(row, origin), explain: { ...checkExtras(row, parseRaw(row.raw_json)), checkout_depth: checkoutOf(row, parseRaw(row.raw_json)) } } };
      },
    });
    let resp: unknown;
    try {
      resp = await handler(parsed.method, parsed.params, parsed.id);
    } catch (e) {
      resp = mcpErrorFor(e, parsed.id);
    }
    if (resp === undefined || resp === null) resp = { jsonrpc: "2.0", id: parsed.id ?? null, error: { code: -32603, message: "empty result", data: { retryable: true, retry_after_s: 2 } } };
    for (const c of ((resp as { result?: { content?: { type?: string; text?: string }[] } }).result?.content ?? [])) if (c.type === "text" && !c.text?.trim()) c.text = "no matches: 0 results for these filters";
    return Response.json(resp, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  // KM-011: GET /claim is read-only (form + stored claim status, no outbound fetch, no writes). The nostr.json check and
  // the claim write happen only on POST /claim from our own form (same-origin), rate-limited per domain and globally.
  if (path === "/claim" && request.method === "GET") {
    const domain = url.searchParams.get("domain") ?? "";
    let resultHtml = "";
    if (domain) {
      const v = validateClaimDomain(domain);
      if (!v.ok) resultHtml = `<p class="km-err">${escHtml(v.message)}</p>`;
      else if (env.DB) {
        try {
          const rows = (await env.DB.prepare("SELECT pubkey, checked_at FROM claims WHERE d = ?").bind(v.domain).all<{ pubkey: string; checked_at: number }>()).results ?? [];
          resultHtml = rows.length ? `<p>Claimed by NIP-05 <code>_@${escHtml(v.domain)}</code>:</p><ul>${rows.map((r) => `<li>${escHtml(hexToNpub(r.pubkey))} (checked ${escHtml(new Date(r.checked_at * 1000).toISOString().slice(0, 10))})</li>`).join("")}</ul>` : `<p>No NIP-05 claim stored for ${escHtml(v.domain)} yet.</p>`;
        } catch { resultHtml = ""; }
      }
    }
    return new Response(renderClaim(origin, domain, resultHtml, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (path === "/claim" && request.method === "POST") {
    const o = request.headers.get("Origin");
    if (o && o !== origin && o !== `${url.protocol}//${url.host}`) return new Response("cross-site claim refused", { status: 403 });
    const text = (await request.text()).slice(0, 2048);
    let domain = "";
    try { domain = (request.headers.get("content-type") ?? "").includes("json") ? String((JSON.parse(text) as { domain?: unknown }).domain ?? "") : new URLSearchParams(text).get("domain") ?? ""; } catch { domain = ""; }
    const v = validateClaimDomain(domain);
    let resultHtml: string;
    if (!v.ok) resultHtml = `<p class="km-err">${escHtml(v.message)}</p>`;
    else if (env.DB && await takeAll(env.DB, [{ k: `claim:d:${v.domain}:${Math.floor(Date.now() / 600_000)}`, limit: 2, ttlS: 1200 }, { k: `claim:g:${Math.floor(Date.now() / 3_600_000)}`, limit: 120, ttlS: 7200 }]).catch(() => null))
      resultHtml = `<p class="km-err">Too many checks for this domain right now; try again in 10 minutes.</p>`;
    else {
      const res = await fetchNostrJson(v.domain);
      if (!res.ok) resultHtml = `<p>Not found: ${escHtml(res.error ?? "unknown")}</p>`;
      else {
        const entries = Object.entries(res.names).map(([n, pk]) => `<li><code>${escHtml(n)}</code>: ${escHtml(pk)} (${escHtml(hexToNpub(pk))})${n === "_" ? " ← domain key" : ""}</li>`).join("");
        resultHtml = `<p>Found nostr.json (HTTP ${res.status}). CORS: ${res.cors ? "yes" : "no"}</p><ul>${entries}</ul>`;
        if (res.underscore && /^[0-9a-f]{64}$/.test(res.underscore) && env.DB) {
          try { // KM-017: idempotent upsert; never surface raw DB errors
            await env.DB.prepare("INSERT INTO claims (d, pubkey, nip05, checked_at) VALUES (?,?,?,?) ON CONFLICT(d, pubkey) DO UPDATE SET checked_at = excluded.checked_at").bind(v.domain, res.underscore, `_@${v.domain}`, Math.floor(Date.now() / 1000)).run();
            await markFacilitatedHistory(env.DB, v.domain);
            await refreshFlagCache(env.DB, await buildFlagStatic(snap));
            resultHtml += `<p>Claim stored for ${escHtml(v.domain)}.</p>`;
          } catch { resultHtml += `<p class="km-err">Could not store the claim right now; please try again.</p>`; }
        }
      }
    }
    return new Response(renderClaim(origin, v.ok ? v.domain : domain, resultHtml, shell), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  if (path === "/_ingest" && request.method === "POST") {
    if (!env.INGEST_TOKEN) return new Response("disabled", { status: 404 });
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.INGEST_TOKEN}`) return new Response("unauthorized", { status: 401 });
    const text = await request.text();
    const { rows, report } = await ingestFromNdjsonText(text, {
      verifyEvents: true,
      sourceLabel: "http-ingest",
    });
    await persistIngest(rows, report, env);
    resetSnapshotCache();
    return Response.json(report);
  }

  if (request.method === "GET") {
    if (path === "/") {
      const q = url.searchParams.get("q");
      const validated = validateQueryParams(url.searchParams);
      const params = validated.ok ? validated.params : {};
      if (q) params.q = q.toLowerCase();
      const result = querySnapshot(snap, { ...params, limit: 20 });
      return new Response(renderHome(snap, origin, q, result.items, shell), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    }
    if (path === "/dashboard") {
      const validated = validateQueryParams(url.searchParams);
      if (!validated.ok) return new Response(render404(origin, shell), { status: 400 });
      const result = querySnapshot(snap, validated.params);
      return new Response(renderDashboard(snap, origin, url.searchParams, result.items, result.total, shell, await allTiers().catch(() => undefined)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/about") return new Response(renderAbout(origin, snap, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/contribute") return new Response(renderContribute(origin, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/docs/api") return new Response(renderDocsApi(origin, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/docs/nostr-tags") return new Response(renderDocsNostrTags(origin, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/docs/relay-filters") return new Response(renderDocsRelayFilters(origin, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return new Response(render404(origin, shell), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

export async function bootstrapFixtures(env: Env, ndjson: string): Promise<void> {
  const { rows, report } = await ingestFromNdjsonText(ndjson, {
    allowSynthetic: true,
    sourceLabel: "fixture",
  });
  await persistIngest(rows, report, env);
  resetSnapshotCache();
}

/** R5-003: per-event take first (concurrent copies of one note count once), then the per-key day cap.
 * Returns true when the request must be refused. */
async function exTake(db: D1Database, id: string, pubkey: string): Promise<boolean> {
  const hit = await takeAll(db, [{ k: `ex:ev:${id}`, limit: 1, ttlS: 2 * 86400 }, { k: `ex:pk:${pubkey}:${new Date().toISOString().slice(0, 10)}`, limit: REVIEW_LIMITS.perPubkeyPerDay, ttlS: 2 * 86400 }]);
  return !!hit && !hit.k.startsWith("ex:ev:");
}

/** KM-R1-001: the badge carries merchant-controlled text, so it must never be a String.replace replacement *string*
 * ("$`", "$&", "$'" would expand). Always splice with a replacer function. */
export const H1_RE = /(<h1>[^<]*<\/h1>)/;
export function spliceBadge(h1: string, badge: string): string { return h1 + badge; }
export function insertAfterH1(html: string, badge: string): string { return html.replace(H1_RE, (m) => spliceBadge(m, badge)); }

/** Per-review "tipped" display: zap receipts (validated where the LNURL zap key is known) and nutzaps. Display only. */
async function tippedFor(db: D1Database | undefined, d: string, ids: string[]): Promise<Map<string, { zaps: number; zap_sats: number; zap_validated: number; nutzaps: number; nutzap_sats: number; nutzap_checked: number }>> {
  const out = new Map<string, { zaps: number; zap_sats: number; zap_validated: number; nutzaps: number; nutzap_sats: number; nutzap_checked: number }>();
  if (!db || !ids.length) return out;
  const get = (id: string) => out.get(id) ?? out.set(id, { zaps: 0, zap_sats: 0, zap_validated: 0, nutzaps: 0, nutzap_sats: 0, nutzap_checked: 0 }).get(id)!;
  try { const t = await loadTips(db, d); for (const id of ids) for (const z of (t.byNote.get(id) ?? []).filter((x) => !x.self)) { const g = get(id); g.zaps++; g.zap_sats += z.sats ?? 0; if (z.validated) g.zap_validated++; } } catch { /* */ }
  for (const [id, l] of await loadNutzaps(db, ids)) for (const n of l) { const g = get(id); g.nutzaps++; g.nutzap_sats += n.sats; if (n.locked_to_recipient && n.mint_listed) g.nutzap_checked++; }
  return out;
}
