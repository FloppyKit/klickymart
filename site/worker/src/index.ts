import { handleRequest } from "./router";

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
  PREVIEW_DATA?: string;
}
