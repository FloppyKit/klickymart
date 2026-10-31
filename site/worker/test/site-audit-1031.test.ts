/** Site audit 2026-10-31: SEO/meta, JSON-LD, MCP server card, llms files, markdown. */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
const O = "https://example.com";
const html = async (p: string) => (await SELF.fetch(O + p, { headers: { accept: "text/html" } })).text();
const lds = (h: string) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));

describe("site audit 10-31", () => {
  it("canonical, og and twitter tags; unique descriptions", async () => {
    const descs = new Set<string>();
    for (const p of ["/", "/about", "/docs/api", "/contribute"]) {
      const h = await html(p);
      expect(h, p).toMatch(new RegExp(`<link rel="canonical" href="https://[a-z.]+${p.replace(/\//g, "\\/")}">`));
      for (const t of ['property="og:title"', 'property="og:description"', 'property="og:url"', 'name="twitter:card"', 'property="og:image"']) expect(h, p + t).toContain(t);
      descs.add(h.match(/<meta name="description" content="([^"]*)"/)![1]!);
    }
    expect(descs.size).toBe(4);
  });
  it("home has WebSite+SearchAction, Organization and Dataset JSON-LD", async () => {
    const t = lds(await html("/")).map((x) => x["@type"]);
    expect(t).toEqual(expect.arrayContaining(["WebSite", "Organization", "Dataset"]));
    const ws = lds(await html("/")).find((x) => x["@type"] === "WebSite");
    expect(ws.potentialAction.target.urlTemplate).toContain("/q?q=");
  });
  it("merchant page: domain title, record-derived description, no Organization block, no ratings", async () => {
    const q = await (await SELF.fetch(O + "/q?limit=1")).json<any>();
    const d = q.items[0].d;
    const h = await html(`/merchant/${d}`);
    expect(h).toContain(`<title>Can agents shop at ${d}? · KlickyMart</title>`);
    expect(h).toMatch(new RegExp(`<meta name="description" content="${d.replace(/\./g, "\\.")} on KlickyMart`));
    const l = lds(h);
    expect(l.some((x) => x["@type"] === "Organization")).toBe(false);
    expect(l.find((x) => x["@type"] === "WebPage").about["@type"]).toBe("OnlineStore");
    expect(JSON.stringify(l)).not.toMatch(/aggregateRating|ratingValue/);
  });
  it("MCP server card lists exactly the MCP tools", async () => {
    const c = await (await SELF.fetch(O + "/.well-known/mcp/server-card.json")).json<any>();
    const m = await (await SELF.fetch(O + "/.well-known/mcp.json")).json<any>();
    expect(c.tools.map((t: any) => t.name)).toEqual(m.tools);
    expect(c.remotes[0].url).toMatch(/^https:\/\/[a-z.]+\/mcp$/);
  });
  it("llms.txt has llmstxt.org link sections; llms-full is genuinely fuller; markdown + security.txt", async () => {
    const l = await html("/llms.txt"), f = await html("/llms-full.txt");
    expect(l.startsWith("# KlickyMart\n\n> ")).toBe(true);
    expect(l).toMatch(/\n## Docs\n- \[API docs\]\(/);
    expect(f.length).toBeGreaterThan(l.length + 5000);
    expect(f).toContain("## MCP tools");
    const md = await SELF.fetch(O + "/", { headers: { accept: "text/markdown" } });
    expect(md.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await (await SELF.fetch(O + "/.well-known/security.txt")).text()).toMatch(/^Contact: mailto:/);
  });
});
