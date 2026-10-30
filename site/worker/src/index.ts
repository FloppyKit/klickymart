import { handleRequest, type Env as RouterEnv } from "./router";
import { catchUp, relayList } from "./relay-ingest";
import { ingestCtx } from "./ingester-do";
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
      return env.ASSETS.fetch(request);
    }

    return handleRequest(request, env);
  },

  /** Every 5 minutes: since-based catch-up from each relay, and make sure the live ingester DO is running. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const e = env as unknown as RouterEnv;
    ctx.waitUntil((async () => {
      if (env.INGESTER) {
        try { await env.INGESTER.get(env.INGESTER.idFromName("main")).fetch("https://ingester/ensure"); } catch { /* reported via ingest_state */ }
      }
      if (env.DB) await catchUp(env.DB, relayList(env.RELAY_URLS), await ingestCtx(e));
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
  CRAWLER_PUBKEY_HEX?: string;
  INGESTER?: DurableObjectNamespace;
}
