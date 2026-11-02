import { describe, expect, it, vi, afterEach } from "vitest";
import { SELF, env } from "cloudflare:test";
const createExecutionContext = () => { const ps: Promise<unknown>[] = []; return { ps, waitUntil: (p: Promise<unknown>) => { ps.push(p); }, passThroughOnException: () => {}, props: {} }; };
const waitOnExecutionContext = async (c: { ps: Promise<unknown>[] }) => { await Promise.allSettled(c.ps); };
import worker from "../src/index";
import { RETAILER_NOTICES, TARGET_APPROVED_AGENTS_QUOTE, linkoutsEnabled, linkoutsFor, linkoutsHtml, LINKOUT_NOTE } from "../src/linkouts";
import SRC from "../src/linkouts.ts?raw";

const call = async (path: string, extra: Record<string, string>) => {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request(`https://example.com${path}`, { headers: { accept: "application/json" } }), { ...env, ...extra } as never, ctx as never);
  await waitOnExecutionContext(ctx); return r;
};
afterEach(() => vi.restoreAllMocks());

describe("M4 S6 Amazon/Target link-outs (KM_LINKOUTS)", () => {
  it("default off", () => { expect(linkoutsEnabled({})).toBe(false); expect(linkoutsEnabled({ KM_LINKOUTS: "on" })).toBe(true); });
  it("static search URLs, encoded, each passes along store terms, no price or stock", () => {
    const l = linkoutsFor("pasta & sauce <b>");
    expect(l.map((x) => x.url)).toEqual(["https://www.amazon.com/s?k=pasta%20%26%20sauce%20%3Cb%3E", "https://www.target.com/s?searchTerm=pasta%20%26%20sauce%20%3Cb%3E"]);
    for (const x of l) { expect(x).toMatchObject({ price: null, stock: null, fetched: false }); expect(x.note).toMatch(/KlickyMart doesn't fetch this site\. If your agent shops here, follow the store's terms below\./); }
    expect(linkoutsFor("  ")).toEqual([]);
    const h = linkoutsHtml("<x>");
    expect(h).not.toContain("<x>"); expect(h).not.toMatch(/person must/i); expect(h).toContain(LINKOUT_NOTE.replace(/'/g, "&#39;"));
  });
  it("module never fetches", () => { expect(SRC).not.toMatch(/fetch\(/); });
  it("/offers: absent when off; present when on, with zero requests to amazon/target", async () => {
    const off = await (await SELF.fetch("https://example.com/offers?q=pasta")).json<any>();
    expect(off).not.toHaveProperty("linkouts");
    const spy = vi.spyOn(globalThis, "fetch");
    const on = await (await call("/offers?q=pasta", { KM_LINKOUTS: "on" })).json<any>();
    expect(on.linkouts.map((x: any) => x.store)).toEqual(["amazon.com", "target.com"]);
    expect(JSON.stringify(on.linkouts)).not.toMatch(/"price":\s*\d|"stock":\s*"/);
    expect(spy.mock.calls.filter((c) => /amazon\.|target\./.test(String(c[0] instanceof Request ? c[0].url : c[0])))).toHaveLength(0);
  });
  it("home search page shows the links only when on", async () => {
    const h = async (x: Record<string, string>) => { const ctx = createExecutionContext(); const r = await worker.fetch(new Request("https://example.com/?q=pasta", { headers: { accept: "text/html" } }), { ...env, ...x } as never, ctx as never); await waitOnExecutionContext(ctx); return r.text(); };
    expect(await h({ KM_LINKOUTS: "on" })).toContain("https://www.target.com/s?searchTerm=pasta");
    expect(await h({})).not.toContain("km-linkouts");
  });
  it("retailer_notice: fixed format; Target quotes its Approved Agents clause; Amazon has no invented quote", () => {
    const [a, t] = linkoutsFor("rice");
    for (const x of [a!, t!]) { expect(Object.keys(x.retailer_notice).sort()).toEqual(["fetched_at", "note", "quote", "source_url"]); expect(x.retailer_notice.note).toMatch(/does not fetch this site.*own choice.*terms/); }
    expect(t!.retailer_notice).toMatchObject({ source_url: "https://www.target.com/c/terms-conditions/-/N-4sr7l", fetched_at: "2026-11-02T02:08:26Z" });
    expect(TARGET_APPROVED_AGENTS_QUOTE).toContain("The current Approved Agents are: Target’s AI Shopping Assistant, OAI, Google and Microsoft.");
    expect(TARGET_APPROVED_AGENTS_QUOTE).toContain("All other Agentic Commerce Tools are unauthorized, expressly prohibited");
    expect(a!.retailer_notice).toEqual({ source_url: "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088", quote: null, fetched_at: null, note: expect.stringMatching(/^Terms could not be retrieved; read before shopping\./) });
    expect(JSON.stringify(RETAILER_NOTICES)).not.toMatch(/Agent\//); // Associates-only rule not presented as general
    expect(SRC).not.toMatch(/fetch\(/);
  });
});
