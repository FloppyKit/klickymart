import type { Snapshot } from "./index-mem";
import { rowsToSnapshot, snapshotFromJson } from "./index-mem";
import { normalize } from "./normalize";
import { ingestFromNdjsonText, persistIngest } from "./ingest";
import { querySnapshot, validateQueryParams } from "./query";
import { rowToCompact, computeStats, parseRaw, suggestDomains } from "./records-api";
import { buildOpenApi, createMcpHandler, parseMcpRequest } from "./mcp";
import { fetchNostrJson, validateClaimDomain, hexToNpub } from "./claim";
import { licenseMetaBlock, licenseResponseHeaders } from "./license-meta";
import { buildKlickymartWellKnown, buildNostrWellKnown } from "./agent-capabilities";
import { buildSummaryJson } from "./summary-json";
import { buildLlmsTxt } from "./llms";
import { checkDomain } from "./check";
import { getReviews, parseReviewEvent, rateLimitCheck, storeReview, REVIEW_LIMITS } from "./reviews";
import { crawlerPubkeyHexFromSnapshot } from "./crawler-pubkey";
import { NOSTR_KIND_CRAWL_RECORD as K31420 } from "./nostr-kinds";
import { agentStats, recordAgentVisit, visitsToday } from "./agent-visits";
import { buildPageShell, isPreviewDataMode } from "./render/page-shell";
import { landscapeFromSnapshot, landscapeFormulaInputs } from "./landscape-metrics";
import { NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";
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
}

let cachedSnap: Snapshot | null = null;
let metaCheckedAt = 0;
let cachedMetaVersion = "";

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

  const { EMBEDDED_EVENTS_NDJSON, EMBEDDED_RECORDS_FALLBACK_NDJSON } = await import("./fixture-data");
  if (EMBEDDED_EVENTS_NDJSON) {
    const { rows, report } = await ingestFromNdjsonText(EMBEDDED_EVENTS_NDJSON, {
      allowSynthetic: false,
      verifyEvents: true,
      sourceLabel: "nostr-31420-ndjson",
      contentHash: "events-v1",
    });
    if (rows.size > 0) {
      cachedSnap = rowsToSnapshot([...rows.values()], report.version, report.source);
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
  const known = new Set(snap.rows.map((r) => r.d));
  const p = parseReviewEvent(body, (d) => known.has(d));
  if (!p.ok) return { status: 400, body: { ok: false, error: { code: p.code, message: p.message } } };
  if (!env.DB) return { status: 503, body: { ok: false, error: { code: "no_db", message: "storage unavailable" } } };
  try {
    const rl = await rateLimitCheck(env.DB, p.value);
    if (rl) return { status: 429, body: { ok: false, error: rl } };
    if (dryRun) return { status: 200, body: { ok: true, dry_run: true, id: p.value.id, d: p.value.d, stored: false } };
    const st = await storeReview(env.DB, p.value, body);
    return { status: st === "stored" ? 201 : 200, body: { ok: true, id: p.value.id, d: p.value.d, stored: st === "stored", duplicate: st === "duplicate", review_url: `/merchant/${p.value.d}#reviews` } };
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

  if (path === "/reviews" && request.method === "POST") {
    const text = await request.text();
    if (text.length > REVIEW_LIMITS.maxBytes) return Response.json({ ok: false, error: { code: "too_large", message: "event too large" } }, { status: 413 });
    let ev: unknown;
    try { ev = JSON.parse(text); } catch { return Response.json({ ok: false, error: { code: "bad_json", message: "body must be JSON" } }, { status: 400 }); }
    const dry = url.searchParams.get("dry_run") === "1";
    const r = await submitReview(env, snap, ev, dry);
    return Response.json(r.body, { status: r.status, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/reviews" && request.method === "GET") {
    const d = (url.searchParams.get("domain") ?? "").toLowerCase();
    if (!d) return err400("domain", "domain required");
    return Response.json({ ...licenseMetaBlock(), domain: d, a: aTagFor(d), reviews: await getReviews(env.DB, d) }, { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "public, max-age=30" } });
  }

  if (path === "/check" && request.method === "GET") {
    const res0 = checkDomain(snap, url.searchParams.get("domain") ?? "", origin);
    if (!res0.ok) return err400("domain", res0.message);
    const res = res0;
    if (res.body.verdict !== "not-in-index") {
      const rv = await getReviews(env.DB, String(res.body.domain), 0);
      res.body.reviews = { count: rv.count, avg_rating_5: rv.avg_rating_5, url: `${origin}/reviews?domain=${res.body.domain}`, review_a_tag: aTagFor(String(res.body.domain)) };
    }
    if (url.searchParams.get("format") === "html") {
      return new Response(renderCheckResult(origin, res.body, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return Response.json({ ...licenseMetaBlock(), ...res.body }, { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/stats/agents.json" && request.method === "GET") {
    return Response.json(await agentStats(env.DB), { headers: { ...apiHeaders(snap.version, 0), "Cache-Control": "public, max-age=30" } });
  }

  if (path === "/q" && request.method === "GET") {
    const validated = validateQueryParams(url.searchParams);
    if (!validated.ok) return err400(validated.param, validated.message);
    const result = querySnapshot(snap, validated.params);
    const items = result.items.map((r) => rowToCompact(r, origin));
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
        derived: rowToCompact(row, origin),
        nostr: { kind: NOSTR_KIND_CRAWL_RECORD, d: domain, event_id: null, a: aTagFor(domain) },
        reviews: await getReviews(env.DB, domain),
      },
      { headers: apiHeaders(snap.version, 0) },
    );
  }

  if (path.startsWith("/merchant/") && request.method === "GET") {
    const domain = decodeURIComponent(path.slice("/merchant/".length)).toLowerCase();
    const row = snap.rows.find((r) => r.d === domain);
    if (!row) return new Response(render404(origin, shell), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (request.headers.get("Accept")?.includes("text/html")) {
      return new Response(renderMerchant(row, origin, shell, await getReviews(env.DB, domain), aTagFor(domain)), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" } });
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
    return Response.json({ name: "KlickyMart", url: "/mcp", transport: "streamable-http (stateless, JSON responses only)", tools: ["search_merchants", "get_record", "check_domain", "get_reviews", "submit_review"], llms_txt: "/llms.txt" }, { headers: apiHeaders(snap.version, 0) });
  }

  if (path === "/.well-known/nostr.json") {
    const body = buildNostrWellKnown(snap, env.CRAWLER_PUBKEY_HEX);
    return Response.json(body, { headers: apiHeaders(snap.version, 0) });
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
      runQuery: async (sp) => {
        const v = validateQueryParams(sp);
        if (!v.ok) throw new Error(v.message);
        const result = querySnapshot(snap, v.params);
        const items = result.items.map((r) => rowToCompact(r, origin));
        return { body: { version: snap.version, total: result.total, count: result.count, items, filter_ms: result.filter_ms }, filter_ms: result.filter_ms };
      },
      checkDomain: async (domain) => checkDomain(snap, domain, origin),
      submitReview: async (event, dryRun) => submitReview(env, snap, event, dryRun),
      getReviews: async (domain) => ({ domain, a: aTagFor(domain.toLowerCase()), reviews: await getReviews(env.DB, domain.toLowerCase()) }),
      getRecord: async (domain) => {
        const row = snap.rows.find((r) => r.d === domain.toLowerCase());
        if (!row) return null;
        return { body: { record: parseRaw(row.raw_json), derived: rowToCompact(row, origin) } };
      },
    });
    const resp = await handler(parsed.method, parsed.params, parsed.id);
    return Response.json(resp, { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  }

  if (path === "/claim" && request.method === "GET") {
    const domain = url.searchParams.get("domain") ?? "";
    let resultHtml = "";
    if (domain) {
      const v = validateClaimDomain(domain);
      if (!v.ok) resultHtml = `<p class="km-err">${escHtml(v.message)}</p>`;
      else {
        const res = await fetchNostrJson(v.domain);
        if (!res.ok) resultHtml = `<p>Not found: ${escHtml(res.error ?? "unknown")}</p>`;
        else {
          const entries = Object.entries(res.names).map(([n, pk]) => `<li><code>${escHtml(n)}</code>: ${escHtml(pk)} (${escHtml(hexToNpub(pk))})${n === "_" ? " ← domain key" : ""}</li>`).join("");
          resultHtml = `<p>Found nostr.json (HTTP ${res.status}). CORS: ${res.cors ? "yes" : "no"}</p><ul>${entries}</ul>`;
          if (res.underscore && env.DB) {
            await env.DB.prepare("INSERT INTO claims (d, pubkey, nip05, checked_at) VALUES (?,?,?,?)").bind(v.domain, res.underscore, `_${v.domain}`, Math.floor(Date.now() / 1000)).run();
          }
        }
      }
    }
    return new Response(renderClaim(origin, domain, resultHtml, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      return new Response(renderDashboard(snap, origin, url.searchParams, result.items, result.total, shell), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
