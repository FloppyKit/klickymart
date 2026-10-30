/** GO 5.7: outside-shopper QA fixes, checked against the real v0.4 records. */
import { describe, expect, it } from "vitest";
import { findAlternatives, resolveSub } from "../src/alternatives";
import { checkDomain } from "../src/check";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { querySnapshot, validateQueryParams } from "../src/query";
import { mcpToolsList } from "../src/mcp";
import { buildLlmsTxt } from "../src/llms";
import { renderCheckoutDetail, renderAgentPolicy, renderWhy } from "../src/explain";
import { parseRaw } from "../src/records-api";
import REAL from "../../../data/records.ndjson?raw";

const O = "https://klickymart.com";
async function snap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}
const body = (r: ReturnType<typeof checkDomain>) => { if (!r.ok) throw new Error(r.message); return r.body as Record<string, any>; };
const q = (s: Awaited<ReturnType<typeof snap>>, qs: string) => {
  const v = validateQueryParams(new URLSearchParams(qs));
  if (!v.ok) throw new Error(v.message);
  return querySnapshot(s, v.params);
};

describe("QA 2026-10-30 fixes", () => {
  it("amazon.com: pages reachable, but agent ordering restricted, with ToS quotes", async () => {
    const b = body(checkDomain(await snap(), "amazon.com", O));
    expect(b.verdict).toBe("reachable");
    expect(b.agent_ordering.policy).toBe("restricts-agents");
    expect(b.summary).toMatch(/reachable, but .*restrict agent orders/);
    expect(b.agent_ordering.evidence.some((e: { url: string; q: string }) => /nodeId=508088/.test(e.url) && /No Agent may access/.test(e.q))).toBe(true);
  });
  it("non-reachable verdicts carry a reason: robots rule line, ToS clause, HTTP/cause, retry date", async () => {
    const s = await snap();
    const nf = body(checkDomain(s, "netflix.com", O));
    expect(nf.reason.robots_line).toBe("Disallow: /");
    expect(nf.reason.retry_date).toMatch(/^\d{4}-\d\d-\d\d$/);
    const ms = body(checkDomain(s, "microsoft.com", O));
    expect(ms.reason.tos_q).toMatch(/web scraping/);
    expect(ms.reason.tos_url).toMatch(/^https:\/\//);
    for (const r of s.rows.filter((x) => x.status !== "crawled")) expect(parseRaw(r.raw_json).why, r.d).toBeTruthy();
  });
  it("bestbuy.com is re-crawled and no longer 'error'", async () => {
    const b = body(checkDomain(await snap(), "bestbuy.com", O));
    expect(b.verdict).toBe("reachable");
    expect(b.reason).toBeNull();
  });
  it("Bitrefill: Lightning from its own payment help page; Lightning merchant count grew", async () => {
    const s = await snap();
    const br = body(checkDomain(s, "bitrefill.com", O));
    expect(br.pay.online.concat(br.pay.unscoped)).toContain("ln");
    expect(q(s, "pay_group=lightning").total).toBeGreaterThanOrEqual(5);
  });
  it("headphones resolve to audio; Dell/HP/Alibaba are not alternatives; audio sellers are", async () => {
    expect(resolveSub("over-ear headphones")).toEqual({ sub: "audio", category: "electronics" });
    const r = findAlternatives(await snap(), O, { domain: "amazon.com", category: "headphones", limit: 50 });
    if (!r.ok) throw new Error(r.message);
    const ds = r.body.items.map((i) => i.d);
    expect(ds).toEqual(expect.arrayContaining(["bose.com", "sonos.com"]));
    for (const d of ["dell.com", "hp.com", "alibaba.com", "lenovo.com"]) expect(ds).not.toContain(d);
    expect(r.body.sub).toBe("audio");
    // ranking: checkout reached first, then major retailers among equals
    const co = r.body.items.map((i) => i.checkout ?? -1);
    expect([...co].sort((a, b) => b - a)).toEqual(co);
    expect(r.body.turned_away.map((t) => t.d)).toEqual(expect.arrayContaining(["bhphotovideo.com"]));
  });
  it("/q and MCP search_merchants agree with llms.txt (sub, reachable, ship filters)", async () => {
    const s = await snap();
    expect(q(s, "sub=audio&reachable=1").total).toBeGreaterThan(3);
    q(s, "ship_pre=1"); q(s, "ships_us=1"); q(s, "free_ship_max=50");
    const tool = (mcpToolsList() as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools.find((t) => t.name === "search_merchants")!;
    const llms = buildLlmsTxt(O, "bot@klickymart.com", []);
    for (const k of ["reachable", "sub", "ship_pre", "ships_us", "free_ship_max", "guest", "co_min", "cat", "category", "pay_group"]) {
      expect(Object.keys(tool.inputSchema.properties), k).toContain(k);
      expect(llms, k).toContain(k);
    }
    const alt = (mcpToolsList() as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools.find((t) => t.name === "find_alternatives")!;
    expect(Object.keys(alt.inputSchema.properties)).toContain("sub");
  });
  it("checkout depth / guest are filled for more stores and render with provenance", async () => {
    const s = await snap();
    const filled = s.rows.filter((r) => r.guest !== null || r.co !== null);
    expect(filled.length).toBeGreaterThanOrEqual(10);
    const row = s.rows.find((r) => r.d === "cryptocloaks.com")!;
    const html = renderCheckoutDetail(row, parseRaw(row.raw_json));
    expect(html).toContain("Guest checkout: <strong>yes</strong>");
    expect(html).toContain("checkout-probe");
    const am = s.rows.find((r) => r.d === "amazon.com")!;
    expect(renderAgentPolicy(parseRaw(am.raw_json))).toContain("Agent ordering policy");
    const nf = s.rows.find((r) => r.d === "netflix.com")!;
    expect(renderWhy(parseRaw(nf.raw_json))).toContain("Disallow: /");
  });
});
