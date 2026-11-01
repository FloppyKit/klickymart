import { handleRequest, loadSnapshot, mcpErrorFor, type Env as RouterEnv } from "./router";
import { writeDailyHead } from "./open-store";
import { catchUp, relayList } from "./relay-ingest";
import { ingestCtx, liveIngestEnabled } from "./ingester-do";
import { HTML_CSP } from "./render/layout";
export { RelayIngester } from "./ingester-do";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Let static assets handle /bot, css, js, favicon when not run_worker_first
    if (
      path.startsWith("/bot")
      || path === "/km.css"
      || path === "/tokens.css"
      || path === "/km.js"
      || path === "/km-landscape.js"
      || path === "/favicon.svg"
      || path === "/og.png"
      || path === "/DATA-LICENSE"
    ) {
      return withCsp(await env.ASSETS.fetch(request));
    }

    const isMcp = path === "/mcp" && request.method === "POST";
    const body = isMcp ? await request.clone().text().catch(() => "") : "";
    try {
      return withCsp(await nonEmpty(await handleRequest(request, env), request));
    } catch (e) {
      // Never let a thrown error become a plain-text Cloudflare 1101 page.
      if (isMcp) {
        let id: unknown = null; try { id = (JSON.parse(body) as { id?: unknown }).id ?? null; } catch { /* */ }
        return Response.json(mcpErrorFor(e, id), { headers: { "Access-Control-Allow-Origin": "*" } });
      }
      // KM-017: never echo raw error text (DB schema, engine details) to clients.
      console.error("unhandled", e instanceof Error ? e.message : String(e));
      return Response.json({ error: { code: "internal", message: "temporary error, please retry", retryable: true, retry_after_s: 2 } },
        { status: 503, headers: { "Retry-After": "2", "Access-Control-Allow-Origin": "*" } });
    }
  },

  /** Every 5 minutes: since-based catch-up from each relay, and make sure the live ingester DO is running. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const e = env as unknown as RouterEnv;
    ctx.waitUntil((async () => {
      if (env.INGESTER && liveIngestEnabled(e)) {
        try { await env.INGESTER.get(env.INGESTER.idFromName("main")).fetch("https://ingester/ensure"); } catch { /* reported via ingest_state */ }
      }
      if (env.DB) await catchUp(env.DB, relayList(env.RELAY_URLS), await ingestCtx(e));
      // M2: one signed-results head per daily cron run, only when KM_SIGNED_RESULTS is on (no-op otherwise).
      if (env.DB) { try { await writeDailyHead(e, (await loadSnapshot(e)).version, Math.floor(Date.now() / 1000)); } catch { /* head stays stale; routes 503 */ } }
    })());
  },
};

export { handleRequest, bootstrapFixtures, loadSnapshot, resetSnapshotCache } from "./router";

interface Env {
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
  LIVE_INGEST?: string;
  CRAWLER_PUBKEY_HEX?: string;
  INGESTER?: DurableObjectNamespace;
  FACILITATOR_SK_HEX?: string;
}

/** Guarantee: no API route answers 200 with an empty body. JSON/text bodies that come back empty become an explicit JSON error. */
export async function nonEmpty(res: Response, req: Request): Promise<Response> {
  if (req.method === "HEAD" || [101, 202, 204, 301, 302, 303, 304, 307, 308].includes(res.status)) return res;
  if (res.headers.get("X-KM-Empty-OK") === "1") return res; // a deliberately empty list (e.g. an empty NDJSON queue) is a valid answer
  const ct = res.headers.get("content-type") ?? "";
  if (!/json|text\/plain|ndjson/.test(ct)) return res;
  const t = await res.clone().text();
  if (t.trim()) return res;
  return Response.json({ error: { code: "empty_response", message: "the handler produced no body; this is a KlickyMart bug, please retry", retryable: true, retry_after_s: 2 }, count: 0, items: [] },
    { status: 503, headers: { "Retry-After": "2", "Access-Control-Allow-Origin": "*" } });
}

/** KM-006: every HTML response gets a strict CSP unless the route already set its own (e.g. /report's stricter one). */
export function withCsp(res: Response): Response {
  if (!/text\/html/i.test(res.headers.get("content-type") ?? "") || res.headers.has("Content-Security-Policy")) return res;
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", HTML_CSP);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return out;
}
