import type { QueryParams } from "./query";
import { validateQueryParams } from "./query";

export function buildOpenApi(origin: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "KlickyMart Agent API",
      version: "0.3-draft",
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
            { name: "category", in: "query", schema: { type: "string", enum: ["shopping"] } },
            { name: "cat", in: "query", schema: { type: "string" } },
            { name: "pay", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 500 } },
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
    },
  };
}

export function queryParamsToMcpArgs(args: Record<string, unknown>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) sp.set(k, v.join(","));
    else sp.set(k, String(v));
  }
  return sp;
}

export function mcpToolsList(): unknown {
  return {
    tools: [
      {
        name: "search_merchants",
        description: "Search KlickyMart merchant records (same filters as GET /q)",
        inputSchema: {
          type: "object",
          properties: {
            q: { type: "string" },
            status: { type: "array", items: { type: "string" } },
            category: { type: "string", enum: ["shopping"], description: "Vertical filter (v1: shopping)" },
            cat: { type: "array", items: { type: "string" }, description: "Subcategory codes (elec, groc, …)" },
            btc_min: { type: "integer" },
            pay: { type: "array", items: { type: "string" } },
            pay_group: { type: "string", enum: ["bitcoin", "lightning", "ecash"] },
            scope: { type: "string" },
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
        description: "Can my agent shop here? Verdict for one domain from the index (reachable, agents-not-welcome, blocked-tos, error, not-in-index), with checkout depth, pay methods, BTC grade, record time and evidence URL. Never triggers a live crawl.",
        inputSchema: {
          type: "object",
          required: ["domain"],
          properties: { domain: { type: "string", description: "Hostname, e.g. example.com" } },
        },
      },
    ],
  };
}

/** Versions whose basic tools/list + tools/call over plain JSON responses we serve. */
export const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];

export type McpHandler = (method: string, params: unknown, id: unknown) => Promise<{ jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } }>;

export function createMcpHandler(deps: {
  runQuery: (sp: URLSearchParams) => Promise<{ body: unknown; filter_ms: number }>;
  getRecord: (domain: string) => Promise<{ body: unknown } | null>;
  checkDomain?: (domain: string) => Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }>;
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
    if (method === "tools/list") return { ...base, result: mcpToolsList() };
    if (method === "tools/call") {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      if (p.name === "search_merchants") {
        const sp = queryParamsToMcpArgs(p.arguments ?? {});
        if (!sp.has("limit")) sp.set("limit", "50");
        const limit = parseInt(sp.get("limit") ?? "50", 10);
        if (limit > 100) sp.set("limit", "100");
        const { body } = await deps.runQuery(sp);
        const items = (body as { items?: { d: string; name: string | null; record: string }[] }).items ?? [];
        const text = items.map((i) => `${i.d} ${i.name ?? ""} ${i.record}`.trim()).join("\n");
        return {
          ...base,
          result: {
            content: [{ type: "text", text }],
            structuredContent: body,
          },
        };
      }
      if (p.name === "get_record") {
        const domain = String(p.arguments?.domain ?? "");
        if (!domain) return { ...base, error: { code: -32602, message: "domain required" } };
        const rec = await deps.getRecord(domain);
        if (!rec) return { ...base, error: { code: -32001, message: "not found" } };
        return { ...base, result: { content: [{ type: "text", text: JSON.stringify(rec.body) }], structuredContent: rec.body } };
      }
      if (p.name === "check_domain" && deps.checkDomain) {
        const r = await deps.checkDomain(String(p.arguments?.domain ?? ""));
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
