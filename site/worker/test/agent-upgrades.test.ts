import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { agentFamily, shopperSplit, SIMULATED_SHOPPER_FLOOR } from "../src/agent-visits";
import { normalizeDomainInput } from "../src/check";
import { MCP_SNIPPETS } from "../src/llms";

const mcp = (body: unknown, ua = "claude-desktop/1.0") =>
  SELF.fetch("https://example.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": ua }, body: JSON.stringify(body) });

describe("llms.txt", () => {
  it("documents endpoints, MCP, schema, relays, licenses, contact", async () => {
    const r = await SELF.fetch("https://example.com/llms.txt");
    expect(r.headers.get("Content-Type")).toContain("text/plain");
    const t = await r.text();
    for (const s of ["/summary.json", "/.well-known/klickymart.json", "/q", "/export.ndjson", "/mcp", "check_domain", "31420", "relay.damus.io", "MIT", "CC0", "bot@klickymart.com"]) expect(t).toContain(s);
  });
  it("is linked from robots.txt and /about", async () => {
    expect(await (await SELF.fetch("https://example.com/robots.txt")).text()).toContain("/llms.txt");
    const about = await (await SELF.fetch("https://example.com/about", { headers: { Accept: "text/html" } })).text();
    expect(about).toContain('href="/llms.txt"');
    expect(about).toContain("mcp-remote");
    expect(about).toContain("partly simulated");
  });
});

describe("/check", () => {
  it("returns a verdict for an indexed domain", async () => {
    const j = await (await SELF.fetch("https://example.com/check?domain=https://store.google.com/x")).json<Record<string, unknown>>();
    expect(j.domain).toBe("store.google.com");
    expect(j.verdict).toBe("reachable");
    expect(j).toHaveProperty("btc_grade");
    expect(j).toHaveProperty("record_ts");
    expect(j.live_crawl).toBe(false);
  });
  it("maps blocked-tos", async () => {
    const j = await (await SELF.fetch("https://example.com/check?domain=microsoft.com")).json<Record<string, unknown>>();
    expect(j.verdict).toBe("blocked-tos");
    expect(String(j.evidence)).toContain("microsoft.com");
  });
  it("says not in index yet for unknown domains and never crawls", async () => {
    const j = await (await SELF.fetch("https://example.com/check?domain=never-heard-of-it.test")).json<Record<string, unknown>>();
    expect(j.verdict).toBe("not-in-index");
    expect(j.message).toBe("not in index yet");
  });
  it("rejects junk", async () => {
    expect((await SELF.fetch("https://example.com/check?domain=%20")).status).toBe(400);
    expect(normalizeDomainInput("localhost")).toBeNull();
  });
  it("renders an html result and the homepage box", async () => {
    const home = await (await SELF.fetch("https://example.com/", { headers: { Accept: "text/html" } })).text();
    expect(home).toContain('data-testid="check-form"');
    const h = await (await SELF.fetch("https://example.com/check?format=html&domain=microsoft.com")).text();
    expect(h).toContain('data-verdict="blocked-tos"');
  });
});

describe("MCP", () => {
  it("check_domain tool over POST /mcp", async () => {
    const j = await (await mcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "check_domain", arguments: { domain: "nope.test" } } })).json<{ result: { structuredContent: { verdict: string } } }>();
    expect(j.result.structuredContent.verdict).toBe("not-in-index");
  });
  it("notifications get 202 and GET is 405 (stateless transport)", async () => {
    expect((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await SELF.fetch("https://example.com/mcp")).status).toBe(405);
  });
  it("negotiates a supported protocol version", async () => {
    const j = await (await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).json<{ result: { protocolVersion: string } }>();
    expect(j.result.protocolVersion).toBe("2025-03-26");
  });
  it("snippets point at the public endpoint", () => {
    expect(MCP_SNIPPETS.cursor).toContain("https://klickymart.com/mcp");
    expect(MCP_SNIPPETS.claude).toContain("mcp-remote");
  });
});

describe("agent visits", () => {
  it("classifies coarse families only", () => {
    expect(agentFamily("Claude-User/1.0")).toBe("claude");
    expect(agentFamily("ChatGPT-User/1.0")).toBe("openai");
    expect(agentFamily("Cursor/1.2")).toBe("cursor");
    expect(agentFamily("curl/8.5.0")).toBe("curl");
    expect(agentFamily("python-requests/2.31")).toBe("python");
    expect(agentFamily("weird")).toBe("other");
    expect(agentFamily(null)).toBe("other");
  });
  it("keeps a simulated floor and caps shoppers", () => {
    expect(shopperSplit(0)).toEqual({ real: 0, simulated: SIMULATED_SHOPPER_FLOOR, total: SIMULATED_SHOPPER_FLOOR });
    expect(shopperSplit(1000).total).toBe(8);
    expect(shopperSplit(1000).simulated).toBe(0);
  });
  it("counts counted paths by family and stores no IP or UA", async () => {
    await SELF.fetch("https://example.com/llms.txt", { headers: { "User-Agent": "curl/8.5.0", "CF-Connecting-IP": "203.0.113.9" } });
    await SELF.fetch("https://example.com/q?limit=1", { headers: { "User-Agent": "python-httpx/0.27" } });
    const s = await (await SELF.fetch("https://example.com/stats/agents.json")).json<{ total_today: number; by_family: Record<string, number>; by_path: Record<string, number> }>();
    expect(s.by_family.curl).toBeGreaterThanOrEqual(1);
    expect(s.by_path["/q"]).toBeGreaterThanOrEqual(1);
    const { results } = await env.DB.prepare("SELECT * FROM agent_visits").all();
    const dump = JSON.stringify(results);
    expect(dump).not.toContain("203.0.113.9");
    expect(dump).not.toContain("curl/8.5.0");
    expect(Object.keys(results[0] as object).sort()).toEqual(["day", "family", "n", "path"]);
  });
  it("drives landscape shopper attributes", async () => {
    const h = await (await SELF.fetch("https://example.com/about", { headers: { Accept: "text/html" } })).text();
    expect(h).toMatch(/data-agent-visits="\d+" data-shoppers-real="\d+" data-shoppers-simulated="\d+"/);
  });
});
