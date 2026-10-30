import { describe, it, expect } from "vitest";
import { createMcpHandler, parseMcpRequest } from "../src/mcp";

describe("mcp", () => {
  it("parses JSON-RPC", () => {
    const p = parseMcpRequest(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }));
    expect(p?.method).toBe("ping");
  });

  it("tools/list returns two tools", async () => {
    const handler = createMcpHandler({
      runQuery: async () => ({ body: { items: [] }, filter_ms: 0 }),
      getRecord: async () => null,
    });
    const r = await handler("tools/list", {}, 1);
    const tools = (r.result as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(12);
  });
});
