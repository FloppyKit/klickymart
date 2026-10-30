/** Round-1 ShopBot fixes: JSON-RPC errors, one vocabulary, live filters + store facts. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { vocabulary, PAY_CODES, PAY_ALIASES, Q_CATEGORIES, ALT_PAY_FILTERS, BLOCKER_KINDS, SUBCATEGORIES } from "../src/vocab";
import { mcpToolsList } from "../src/mcp";
import { liveItems } from "../src/offers";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import REAL from "../../../data/records.ndjson?raw";

const mcp = async (body: unknown) => {
  const r = await SELF.fetch("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, text: t, json: t ? JSON.parse(t) : null };
};
let SNAP: ReturnType<typeof rowsToSnapshot> | null = null;
const snap = async () => SNAP ?? (SNAP = await (async () => { const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "t" }); return rowsToSnapshot([...rows.values()], report.version, report.source); })());

describe("MCP errors are JSON-RPC, never plain text or empty", () => {
  for (const args of [
    { category: "gift-cards", pay: "lightning", guest: true, limit: 10 },
    { q: "hardware wallet", btc: "onchain", limit: 10 },
    { q: "coffee", pay: "shop-pay", limit: 10 },
    { q: "hardware wallet", pay: "btc-onchain" },
    { pay: "not-a-code" },
  ]) it(`search_merchants ${JSON.stringify(args)}`, async () => {
    const r = await mcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_merchants", arguments: args } });
    expect(r.status).toBe(200); expect(r.text.length).toBeGreaterThan(0);
    expect(r.json.jsonrpc).toBe("2.0"); expect(r.json.id).toBe(7);
    if (r.json.error) { expect(typeof r.json.error.code).toBe("number"); expect(r.json.error.data).toHaveProperty("retryable"); }
    else expect(r.json.result).toBeTruthy();
  });
  it("the previously failing combo now succeeds", async () => {
    const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_merchants", arguments: { category: "gift-cards", pay: "lightning", guest: true } } });
    expect(r.json.error).toBeUndefined();
  });
  it("unknown btc value -> -32602 with a hint", async () => {
    const r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_merchants", arguments: { btc: "onchain" } } });
    expect(r.json.error.code).toBe(-32602); expect(r.json.error.data.retryable).toBe(false);
  });
});

describe("one vocabulary across /q, MCP, llms.txt and openapi", () => {
  it("llms.txt, openapi and MCP schemas use the vocab lists", async () => {
    const llms = await (await SELF.fetch("https://example.com/llms.txt")).text();
    for (const c of [...PAY_CODES, ...Q_CATEGORIES, ...SUBCATEGORIES, ...BLOCKER_KINDS, ...Object.keys(ALT_PAY_FILTERS)]) expect(llms, c).toContain(c);
    const spec = await (await SELF.fetch("https://example.com/openapi.json")).json<any>();
    const qcat = spec.paths["/q"].get.parameters.find((p: any) => p.name === "category").schema.enum;
    expect(qcat).toEqual(Q_CATEGORIES);
    const tools = (mcpToolsList() as any).tools;
    const sm = tools.find((t: any) => t.name === "search_merchants").inputSchema.properties;
    expect(sm.category.enum).toEqual(Q_CATEGORIES);
    for (const a of Object.keys(PAY_ALIASES)) expect(sm.pay.items.enum).toContain(a);
    const fa = tools.find((t: any) => t.name === "find_alternatives").inputSchema.properties;
    expect(fa.pay.enum).toEqual(Object.keys(ALT_PAY_FILTERS));
  });
  it("every documented pay code/alias/group and q-category is accepted by /q", async () => {
    const v = vocabulary();
    for (const c of [...v.pay_codes, ...Object.keys(v.pay_aliases), ...v.pay_groups]) expect((await SELF.fetch(`https://example.com/q?pay=${encodeURIComponent(c)}&limit=1`)).status, c).toBe(200);
    for (const c of v.q_categories) expect((await SELF.fetch(`https://example.com/q?category=${c}&limit=1`)).status, c).toBe(200);
    for (const c of v.alternatives_pay) expect((await SELF.fetch(`https://example.com/alternatives?category=electronics&pay=${c}`)).status, c).toBe(200);
  });
});

describe("live Shopify Catalog results: filters after fetch + store facts", () => {
  const products = [
    { title: "Cheap grinder", variants: [{ url: "https://www.bose.com/p/x", price: { amount: 9900, currency: "USD" }, availability: { available: true } }] },
    { title: "Pricey grinder", variants: [{ url: "https://unknown-shop.example/p/y", price: { amount: 17999, currency: "USD" }, availability: { available: true } }] },
    { title: "Sold out", variants: [{ url: "https://unknown-shop.example/p/z", price: { amount: 5000, currency: "USD" }, availability: { available: false } }] },
  ];
  it("max_price and in_stock are applied and reported", async () => {
    const r = liveItems(products, await snap(), "https://x", { q: "grinder", max_price: 150, in_stock: true, zip: "66061" });
    expect(r.items.map((i: any) => i.title)).toEqual(["Cheap grinder"]);
    expect(r.dropped_by_filters).toBe(2); expect(r.note).toMatch(/filtered the live results/);
  });
  it("indexed stores get store facts + landed; others say not indexed", async () => {
    const r = liveItems(products, await snap(), "https://x", { q: "grinder", zip: "66061" });
    const a = r.items[0] as any, b = r.items[1] as any;
    expect(a.store.indexed).toBe(true); expect(a.store.domain).toBe("bose.com"); expect(a.store).toHaveProperty("pay_shop_pay"); expect(a.landed.est_tax).toBeCloseTo(8.62, 1);
    expect(b.store.indexed).toBe(false); expect(b.store.note).toMatch(/not indexed/);
  });
});

describe("one-call landed price", () => {
  it("/landed requires zip and returns store facts + est tax rate", async () => {
    expect((await SELF.fetch("https://example.com/landed?q=headphones")).status).toBe(400);
    const j = await (await SELF.fetch("https://example.com/landed?q=headphones&zip=66061")).json<any>();
    expect(j.state).toBe("KS");
    for (const i of j.items) { expect(i).toHaveProperty("store"); expect(i).toHaveProperty("landed"); if (i.landed.est_total != null) expect(i.landed.shipping).toBeTruthy(); }
  });
  it("MCP get_landed_price works and errors as JSON-RPC", async () => {
    const ok = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_landed_price", arguments: { q: "headphones", zip: "66061" } } });
    expect(ok.json.result.structuredContent.zip).toBe("66061");
    const bad = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_landed_price", arguments: { q: "headphones" } } });
    expect(bad.json.error.code).toBe(-32602);
  });
});
