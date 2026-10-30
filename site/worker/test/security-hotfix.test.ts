import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { renderMerchant } from "../src/render/pages";
import { jsonForScript, HTML_CSP } from "../src/render/layout";
import { mcpToolsList } from "../src/mcp";

const EVIL = "Evil</script><img src=x onerror=alert(document.domain)>\u2028x";

describe("KM-002: facilitation paused", () => {
  it("POST /facilitate returns 503 facilitation_paused and never signs", async () => {
    const r = await SELF.fetch("https://example.com/facilitate", { method: "POST", body: JSON.stringify({ domain: "store.google.com", agent_pubkey: "00".repeat(32), proof: { type: "hash", sha256: "ef".repeat(32) } }) });
    expect(r.status).toBe(503);
    const b = await r.json() as { ok: boolean; error: { code: string }; event?: unknown };
    expect(b.ok).toBe(false); expect(b.error.code).toBe("facilitation_paused"); expect(b.event).toBeUndefined();
  });
  it("MCP tools/list hides facilitate_purchase and tools/call does not sign", async () => {
    const call = (body: unknown) => SELF.fetch("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
    const l = await (await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json() as { result: { tools: { name: string }[] } };
    expect(l.result.tools.map((t) => t.name)).not.toContain("facilitate_purchase");
    const c = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "facilitate_purchase", arguments: { domain: "store.google.com" } } })).text();
    expect(c).not.toContain('"kind":421');
    expect((mcpToolsList() as { tools: { name: string }[] }).tools.map((t) => t.name)).not.toContain("facilitate_purchase");
    expect((mcpToolsList({ facilitate: true }) as { tools: { name: string }[] }).tools.map((t) => t.name)).toContain("facilitate_purchase");
  });
});

describe("KM-006: JSON-LD and HTML escaping, CSP", () => {
  it("jsonForScript cannot close a script element and stays valid JSON", () => {
    const s = jsonForScript({ name: EVIL });
    expect(s).not.toMatch(/<|>|\u2028|\u2029/);
    expect(JSON.parse(s).name).toBe(EVIL);
  });
  it("renderMerchant with a hostile og:site_name has no breakout", () => {
    const row = { d: "evil.example", name: EVIL, status: "ok", ag: "<b>x</b>", btc: null, ts: 1790000000, raw_json: "{}", tos: null } as never;
    const html = renderMerchant(row, "https://klickymart.com", { shopperSplit: undefined } as never);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>x</b>");
    expect((html.match(/<\/script>/g) ?? []).length).toBe((html.match(/<script/g) ?? []).length);
  });
  it("merchant, home and 404 HTML responses carry the strict CSP; /report keeps its own", async () => {
    for (const u of ["/merchant/store.google.com", "/", "/nope-404-page"]) {
      const r = await SELF.fetch("https://example.com" + u, { headers: { accept: "text/html" } });
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("content-security-policy")).toBe(HTML_CSP);
    }
    expect(HTML_CSP).toContain("script-src 'self'"); expect(HTML_CSP).not.toContain("unsafe-eval"); expect(HTML_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    const rep = await SELF.fetch("https://example.com/report", { headers: { accept: "text/html" } });
    const csp = rep.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'"); expect(csp).toContain("script-src 'self';"); expect(csp).not.toMatch(/script-src[^;]*unsafe/); expect(csp).toContain("frame-ancestors 'none'");
  });
});
