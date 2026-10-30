import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { findAlternatives, resolveCategory } from "../src/alternatives";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import REAL from "../../../data/records.ndjson?raw";

async function realSnap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}
import { CATEGORY_MAP } from "../src/category-map";

type Alt = { categories: string[]; items: { d: string; checkout: number | null; agent_access: number | null; btc_grade: number | null; guest: boolean | null; pay: string[]; evidence: string }[] };
const get = async (q: string) => (await SELF.fetch(`https://example.com/alternatives?${q}`)).json<Alt>();

describe("alternatives (GO 5.6)", () => {
  it("maps all 324 domains to coarse categories", () => {
    expect(Object.keys(CATEGORY_MAP.map).length).toBe(324);
    expect(CATEGORY_MAP.map["amazon.com"]).toContain("electronics");
    expect(resolveCategory("headphones")).toBe("electronics");
    expect(resolveCategory("gift card")).toBe("gift-cards");
  });
  it("Amazon -> headphones: reachable electronics stores, ranked, with evidence, excluding amazon (real records)", async () => {
    const r = findAlternatives(await realSnap(), "https://klickymart.com", { domain: "amazon.com", category: "headphones", limit: 50 });
    if (!r.ok) throw new Error(r.message);
    const j = r.body as unknown as Alt;
    expect(j.items.map((i) => i.d)).toEqual(expect.arrayContaining(["bose.com", "sonos.com"]));
    expect(j.categories).toEqual(["electronics"]);
    expect(j.items.length).toBeGreaterThan(0);
    expect(j.items.some((i) => i.d === "amazon.com")).toBe(false);
    for (const i of j.items) expect(i.evidence).toMatch(/^https:\/\//);
    const key = (i: Alt["items"][number]) => [i.checkout ?? -1, i.agent_access ?? -1];
    for (let k = 1; k < j.items.length; k++) {
      const [a, b] = [key(j.items[k - 1]!), key(j.items[k]!)];
      expect(a[0]! >= b[0]!).toBe(true); // GO 5.7: checkout reached first; then major retailer / main line (qa-v3.test.ts)
    }
  });
  it("gift card, Lightning, no account (real 250 records)", async () => {
    const r = findAlternatives(await realSnap(), "https://klickymart.com", { category: "gift card", pay: "lightning", guest: true });
    if (!r.ok) throw new Error(r.message);
    const j = r.body as unknown as Alt;
    expect(j.items.map((i) => i.d)).toContain("coincards.com");
    expect(j.items.map((i) => i.d)).not.toContain("thebitcoincompany.com"); // account required
    expect(j.categories).toEqual(["gift-cards"]);
    expect(j.items.length).toBeGreaterThan(0);
    for (const i of j.items) {
      expect(i.pay.some((p) => ["ln", "lnurl", "bolt12"].includes(p))).toBe(true);
      expect(i.guest).not.toBe(false);
    }
  });
  it("/check on a blocked site suggests alternatives; MCP tool works; bad input 400", async () => {
    const c = await (await SELF.fetch("https://example.com/check?domain=microsoft.com")).json<{ alternatives?: { items: unknown[] } }>();
    expect(c.alternatives).toBeDefined();
    const h = await (await SELF.fetch("https://example.com/check?format=html&domain=microsoft.com")).text();
    expect(h).toContain("Blocked here? Try these");
    const m = await (await SELF.fetch("https://example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_alternatives", arguments: { category: "gift-cards", pay: "lightning", guest: true } } }) })).json<{ result: { structuredContent: Alt } }>();
    expect(m.result.structuredContent.categories).toEqual(["gift-cards"]);
    expect((await SELF.fetch("https://example.com/alternatives?category=zzz")).status).toBe(400);
    expect(await (await SELF.fetch("https://example.com/llms.txt")).text()).toContain("/alternatives");
  });
});
