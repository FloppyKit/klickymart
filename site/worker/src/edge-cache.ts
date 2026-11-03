/** GO-KM-D1-SCANS: a short-TTL edge cache in front of the heavy public reads.
 *
 * Why: every one of these routes re-scans D1 tables (experiences, reviews, note_flags, nostr_events) on every request, so
 * anyone looping a public GET can burn the daily D1 budget (5.34M rows on 2026-10-31; ~74k rows/min in the 11-02 burst).
 * A Workers Cache API read is free and does not touch D1, so a repeat request inside the TTL costs 0 rows.
 *
 * Rules this file keeps:
 * - Only keyless, session-free, public GETs (plus the three read-only MCP tools) are cached. POST routes, auth, /reviews,
 *   /submit and anything that already answers no-store are never cached.
 * - The key is the route plus ONLY its documented params, normalized: unknown params are dropped, order does not matter,
 *   values are lowercased where the docs say so, lists are sorted and documented defaults are filled. Adding junk params
 *   therefore cannot mint new cache entries (`/q?q=x&junk=1` and `/q?q=x` share one key).
 * - Responses that depend on the request (cookies, live upstream fetches) are not cached; the handlers of the routes here
 *   read no session and make no outbound call, except /offers and MCP find_offers with live=1, which are excluded below.
 * - TTLs are per route (below) and short: 60-120 s. The served body may therefore be up to one TTL old, and nothing else.
 */
import { KNOWN_PARAMS, validateQueryParams } from "./query";

/** Turn the cache off with KM_EDGE_CACHE=0/off/false (also used by tests that need an uncached baseline). */
const off = (v?: string) => { const s = (v ?? "").trim().toLowerCase(); return s === "0" || s === "false" || s === "off"; };
let override: boolean | null = null;
/** Test hook: null = follow the env var, true/false = force. Nothing in worker/src calls this. */
export function setEdgeCacheEnabled(v: boolean | null): void { override = v; }
export function edgeCacheOn(env: { KM_EDGE_CACHE?: string }): boolean { return override ?? !off(env.KM_EDGE_CACHE); }

/** TTL per route, in seconds, chosen from how fresh that route has to be:
 * - /           120 s: the home page lists index rows; the index only changes on an ingest.
 * - /chart     120 s: ranking over community notes; the JSON already answered max-age=60.
 * - /chart.json 120 s: same data as /chart.
 * - /q          60 s:  a directory query; scrapers loop on this one, and 60 s is the freshness the JSON promised anyway.
 * - /check      60 s:  store facts; the HTML form already answered max-age=60.
 * - /alternatives 120 s: derived from the index only.
 * - /offers     60 s:  offers come from the embedded crawl file, not D1.
 * - /records,/merchant 60 s: store card + reviews + tips + community block.
 * - /tips.json,/curators.json 60 s: zaps arrive with the relay catch-up (every 5 minutes), so 60 s is fresh enough.
 * - /flags.json 120 s: the flag cache only changes when a note or report is written.
 * - MCP read tools 60 s: search_merchants / find_offers / get_record answer the same way as the GETs above. */
export const CACHE_TTLS = {
  "/": 120, "/chart": 120, "/chart.json": 120, "/q": 60, "/check": 60, "/alternatives": 120, "/offers": 60,
  "/records": 60, "/merchant": 60, "/tips.json": 60, "/curators.json": 60, "/flags.json": 120, mcp: 60,
} as const;

/** Cache keys live on their own host so they can never be confused with a real request URL. */
const KEY_ORIGIN = "https://edge-cache.klickymart.internal";

/** Server config that changes these bodies. It is part of the key so a flag flipped by a deploy (or a test that passes a
 * different env) can never be answered from the previous configuration's entry. These are the env keys the cached routes
 * read; anything that only affects an uncached route (login, submissions, open-store) is deliberately left out. */
const CONFIG_KEYS = [
  "SITE_ORIGIN", "CONTACT", "ENVIRONMENT", "SITE_TIP_LUD16", "SITE_ZAP_PUBKEY_HEX", "CUSTODIAL_ZAPPER_KEYS", "CRAWLER_PUBKEY_HEX",
  "KM_TRUST_LABELS", "KM_TRUST_BUYS", "KM_DELIVERED_PRICE", "KM_LINKOUTS", "KM_TAKEDOWN", "KM_CRAWL_QUEUE",
  "CHECKOUT_QUOTES_ENABLED", "PENDING_QUEUE_ENABLED", "PREVIEW_DATA", "USE_TEST_FIXTURES",
] as const;

export function configTag(env: Record<string, unknown>): string {
  return CONFIG_KEYS.map((k) => `${k}=${env[k] === undefined || env[k] === null ? "" : String(env[k])}`).join("&");
}
const VERSION = "v1";

export interface CachePlan { key: string; ttl: number; route: string }

/** Deterministic JSON: object keys sorted recursively, so {a,b} and {b,a} serialize the same. */
function sortedJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`).join(",")}}`;
}

const one = (v: string | null) => (v === null || v === "" ? null : v);
const truthy = (v: string | null) => v !== null && (v === "1" || v === "true");
/** Which representation the route is about to build. Bodies differ by it, so it is part of the key. */
export function variantOf(sp: URLSearchParams, accept: string, kind: "q" | "check" | "alternatives" | "chart" | "home"): string {
  const f = sp.get("format");
  if (kind === "q") {
    if (f === "ndjson") return "ndjson";
    if (f === "html") return "html";
    if (f === "json") return "json";
    return /text\/html/i.test(accept) ? "html" : "json";
  }
  if (kind === "home") return /text\/markdown/i.test(accept ?? "") ? "markdown" : "html";
  if (kind === "check" || kind === "alternatives") return f === "html" ? "html" : "json";
  return f === "html" ? "html" : "json"; // /chart vs /chart.json are separate routes already
}

/** Set-valued /q filters: their order never changes the response (each is applied as a bitmask or a set test), so they
 * are sorted. `sort` is NOT in this list: -btc,-ag,d and d,-btc mean different things. */
const Q_LIST_PARAMS = ["status", "pay", "pay_all", "no_ar", "ar", "cat", "protocol"] as const;

/** GET /q: only the documented params (KNOWN_PARAMS), normalized by the route's own validator (it lowercases q, fills
 * limit/sort/scope defaults, canonicalizes pay codes). Unknown params are dropped, so they can never mint an entry. */
function qKey(sp: URLSearchParams, accept: string): string {
  const copy = new URLSearchParams();
  for (const [k, v] of sp) if (KNOWN_PARAMS.has(k)) copy.append(k, v);
  const v = validateQueryParams(copy);
  const base = v.ok ? { ...v.params } : {}; // the gate below rejects these before anything is cached
  for (const k of Q_LIST_PARAMS) { const list = (base as Record<string, unknown>)[k]; if (Array.isArray(list)) (base as Record<string, unknown>)[k] = [...list].sort(); }
  const minTrust = sp.get("min_trust");
  const params = { ...base, ...(minTrust ? { min_trust: minTrust.toLowerCase() } : {}), variant: variantOf(sp, accept, "q") };
  return `${KEY_ORIGIN}/${VERSION}/q?${sortedJson(params)}`;
}

/** GET /offers + MCP find_offers share offerQuery's documented params. live=1 is never cached (live Shopify Catalog). */
function offersKey(sp: URLSearchParams, accept: string): string | null {
  if (truthy(one(sp.get("live")))) return null; // live Shopify Catalog: never cached
  const p: Record<string, unknown> = {};
  const s = (k: string, lower = false) => { const v = one(sp.get(k)); if (v !== null) p[k] = lower ? v.toLowerCase() : v; };
  s("gtin"); s("mpn"); s("q", true); s("domain", true); s("zip"); s("condition", true); s("type", true);
  if (one(sp.get("in_stock")) !== null) p.in_stock = truthy(one(sp.get("in_stock"))) ? 1 : 0;
  if (one(sp.get("brand_strict")) !== null) p.brand_strict = truthy(one(sp.get("brand_strict"))) ? 1 : 0;
  const mp = one(sp.get("max_price")); if (mp !== null) p.max_price = Number(mp);
  const pay = one(sp.get("pay"));
  if (pay !== null) p.pay = pay.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).sort();
  p.limit = Number(one(sp.get("limit")) ?? 20); // findOffers' documented default
  return `${KEY_ORIGIN}/${VERSION}/offers?${sortedJson(p)}`;
}

function checkKey(sp: URLSearchParams, accept: string): string | null {
  const p: Record<string, unknown> = {};
  const domain = one(sp.get("domain")); if (domain !== null) p.domain = domain.toLowerCase();
  const many = one(sp.get("domains"));
  if (many !== null) p.domains = many.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).sort();
  const zip = one(sp.get("zip")); if (zip !== null) p.zip = zip;
  p.variant = variantOf(sp, accept, "check");
  if (p.domain === undefined && p.domains === undefined) return null; // 400 anyway
  return `${KEY_ORIGIN}/${VERSION}/check?${sortedJson(p)}`;
}

function alternativesKey(sp: URLSearchParams, accept: string): string | null {
  const p: Record<string, unknown> = {};
  const s = (k: string, lower = false, from?: string) => { const v = one(sp.get(from ?? k)); if (v !== null) p[k] = lower ? v.toLowerCase() : v; };
  s("domain", true); s("category", true); if (p.category === undefined) { const q = one(sp.get("q")); if (q !== null) p.category = q.toLowerCase(); }
  s("sub", true); s("pay", true); s("guest", true); s("zip");
  const inc = one(sp.get("include_indirect")) ?? one(sp.get("btc_indirect"));
  if (inc !== null) p.include_indirect = truthy(inc) ? 1 : 0;
  const blk = one(sp.get("include_blocked"));
  if (blk !== null) p.include_blocked = truthy(blk) ? 1 : 0;
  p.limit = Number(one(sp.get("limit")) ?? 10); // findAlternatives' documented default
  p.taxpre = truthy(one(sp.get("taxpre"))) ? 1 : 0;
  p.variant = variantOf(sp, accept, "alternatives");
  return `${KEY_ORIGIN}/${VERSION}/alternatives?${sortedJson(p)}`;
}

function chartKey(path: "/chart" | "/chart.json", sp: URLSearchParams, accept: string): string {
  const p: Record<string, unknown> = { limit: Number(one(sp.get("limit")) ?? 50), category: one(sp.get("category")) };
  p.variant = variantOf(sp, accept, "chart");
  return `${KEY_ORIGIN}/${VERSION}${path}?${sortedJson(p)}`;
}

function domainKey(path: "/tips.json" | "/curators.json" | "/flags.json", sp: URLSearchParams): string {
  const d = one(sp.get("domain"));
  const p: Record<string, unknown> = { domain: d === null ? null : d.toLowerCase() };
  return `${KEY_ORIGIN}/${VERSION}${path}?${sortedJson(p)}`;
}

function pageKey(path: string, sp: URLSearchParams, accept: string): string | null {
  // /records/<domain> and /merchant/<domain>: the path already carries the domain.
  const m = path.match(/^\/(records|merchant)\/(.+)$/);
  if (!m) return null;
  const d = decodeURIComponent(m[2]!).toLowerCase();
  const p: Record<string, unknown> = { d, variant: variantOf(sp, accept, "check") };
  return `${KEY_ORIGIN}/${VERSION}/${m[1]}/${encodeURIComponent(d)}?${sortedJson(p)}`;
}

/** Read-only MCP tools: same inputs, same answer, no session. Everything else on /mcp is left uncached. */
export const CACHED_MCP_TOOLS = ["search_merchants", "find_offers", "get_record"] as const;

function mcpKey(body: string): string | null {
  let msg: { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  try { msg = JSON.parse(body) as typeof msg; } catch { return null; }
  if (msg.method !== "tools/call") return null;
  const name = typeof msg.params?.name === "string" ? msg.params.name : "";
  if (!(CACHED_MCP_TOOLS as readonly string[]).includes(name)) return null;
  const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
  if (name === "find_offers" && (args.live === true || args.live === 1 || args.live === "1" || args.live === "true")) return null;
  const norm: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v === undefined || v === null || v === "") continue;
    norm[k] = typeof v === "string" && ["q", "domain", "pay", "condition", "type", "gtin", "mpn"].includes(k) ? v.toLowerCase() : v;
  }
  return `${KEY_ORIGIN}/${VERSION}/mcp?${sortedJson({ tool: name, args: norm })}`;
}

interface RouteKey { route: keyof typeof CACHE_TTLS; key: string | null }

/** The cache key this request maps to, from its route plus its documented params only, or null when the route is not
 * cacheable at all (live=1, a POST that is not an MCP read tool, anything else). Pure: it does not gate on validity. */
function routeKey(request: Request, env: Record<string, unknown>, body?: string): RouteKey | null {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const accept = request.headers.get("Accept") ?? "";
  const sp = url.searchParams;
  if (request.method === "GET") {
    if (path === "/") return { route: "/", key: `${KEY_ORIGIN}/${VERSION}/?${sortedJson({ variant: variantOf(sp, accept, "home") })}` };
    if (path === "/chart" || path === "/chart.json") return { route: path, key: chartKey(path, sp, accept) };
    if (path === "/q") return { route: "/q", key: qKey(sp, accept) };
    if (path === "/check") return { route: "/check", key: checkKey(sp, accept) };
    if (path === "/alternatives") return { route: "/alternatives", key: alternativesKey(sp, accept) };
    if (path === "/offers") return { route: "/offers", key: offersKey(sp, accept) };
    if (path === "/tips.json" || path === "/curators.json" || path === "/flags.json") return { route: path, key: domainKey(path, sp) };
    if (path.startsWith("/records/") || path.startsWith("/merchant/")) return { route: path.startsWith("/records/") ? "/records" : "/merchant", key: pageKey(path, sp, accept) };
    return null;
  }
  if (request.method === "POST" && path === "/mcp") return { route: "mcp", key: mcpKey(body ?? "") };
  return null;
}

/** routeKey() plus the config fingerprint, so two configurations never share an entry. */
function keyedRoute(request: Request, env: Record<string, unknown>, body?: string): RouteKey | null {
  const rk = routeKey(request, env, body);
  if (!rk || rk.key === null) return rk;
  return { ...rk, key: `${rk.key}&cfg=${encodeURIComponent(configTag(env))}` };
}

/** Decide whether this request may be served from / stored in the edge cache. `body` is only needed for POST /mcp.
 * A request the route itself will reject (a 400, e.g. /q with an unknown param) is NOT cached: its response is already
 * free of D1 work, and serving a cached 200 for it would change what the caller sees. */
export function planEdgeCache(request: Request, env: { KM_EDGE_CACHE?: string }, body?: string): CachePlan | null {
  if (!edgeCacheOn(env)) return null;
  const rk = keyedRoute(request, env as unknown as Record<string, unknown>, body);
  if (!rk || rk.key === null) return null;
  if (new URL(request.url).pathname.replace(/\/$/, "") === "/q") {
    const sp = new URLSearchParams(new URL(request.url).searchParams);
    sp.delete("min_trust");
    if (!validateQueryParams(sp).ok) return null;
  }
  return { route: rk.route, ttl: CACHE_TTLS[rk.route], key: rk.key };
}

/** Fallback store for runtimes/tests where caches.default is unavailable: same key, same TTL, isolate-local. */
const memory = new Map<string, { at: number; ttl: number; status: number; headers: [string, string][]; body: ArrayBuffer }>();
const MEMORY_MAX = 256;

function cacheStore(): Cache | null {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; } catch { return null; }
}

export async function readEdgeCache(plan: CachePlan): Promise<Response | null> {
  const store = cacheStore();
  if (store) {
    try {
      const hit = await store.match(plan.key);
      if (hit) return withMarker(hit, "hit");
    } catch { /* cache errors never fail a request */ }
  }
  const m = memory.get(plan.key);
  if (m) {
    if (Date.now() - m.at < m.ttl * 1000) return withMarker(new Response(m.body.slice(0), { status: m.status, headers: m.headers }), "hit");
    memory.delete(plan.key);
  }
  return null;
}

export async function writeEdgeCache(plan: CachePlan, res: Response): Promise<void> {
  const store = cacheStore();
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", `public, max-age=${plan.ttl}`);
  out.headers.delete("Set-Cookie");
  out.headers.delete("Vary");
  if (store) {
    try { await store.put(plan.key, out.clone()); return; } catch { /* fall through to the isolate map */ }
  }
  try {
    if (memory.size >= MEMORY_MAX) memory.clear();
    memory.set(plan.key, { at: Date.now(), ttl: plan.ttl, status: out.status, headers: [...out.headers], body: await out.arrayBuffer() });
  } catch { /* bodies that cannot be buffered are simply not cached */ }
}

/** Hit marker, so a caller can tell a cache hit from a fresh render without diffing bodies. Bodies are unchanged. */
function withMarker(res: Response, marker: "hit" | "miss"): Response {
  const out = new Response(res.body, res);
  out.headers.set("X-KM-Edge-Cache", marker);
  return out;
}

/** Test hook: drop the isolate-local fallback store (the Cache API store is not visible to tests as a list). */
export function clearEdgeCacheMemory(): void { memory.clear(); }

/** Test hook: forget one entry, so the next request for that key is a real first hit (miss). */
export async function forgetEdgeCache(key: string): Promise<void> {
  memory.delete(key);
  try { await cacheStore()?.delete(key); } catch { /* nothing stored */ }
}

/** The key a request maps to, or null when its route is not cacheable. This is the key-discipline entry point: it drops
 * unknown params, so /q?q=x&junk=1 and /q?q=x both point at the one entry for /q?q=x (the junk request is answered 400
 * by the route itself, unchanged, and is never stored). */
export function cacheKeyFor(request: Request, env: { KM_EDGE_CACHE?: string } = {}, body?: string): string | null {
  return keyedRoute(request, env as unknown as Record<string, unknown>, body)?.key ?? null;
}
