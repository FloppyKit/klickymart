/** Round-2 fixes: product quality, ZIP validation, link/btc_indirect vocab, non-empty bodies, well-known from openapi, /check steps. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { annotate, brandCheck, conditionOf, dedupe, productTypes, applyProductFilters } from "../src/product-quality";
import { buildOpenApi } from "../src/mcp";
import { PAY_CODES, Q_BOOL_FILTERS } from "../src/vocab";
import { nonEmpty } from "../src/index";
import { checkoutOf } from "../src/explain";
import { parseRaw } from "../src/records-api";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import REAL from "../../../data/records.ndjson?raw";

const mcp = async (body: unknown) => (await SELF.fetch("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json<any>();

describe("product quality", () => {
  it("flags B0SE as a brand look-alike", () => {
    expect(brandCheck("Bose QuietComfort", "B0SE QuietComfort Ultra Headphones (2nd Gen)").brand_match).toBe("lookalike");
    expect(brandCheck("Bose QuietComfort", "Bose QuietComfort Ultra").brand_match).toBe("ok");
  });
  it("condition and type", () => {
    expect(conditionOf("Open Box QC35 gaming headset").condition).toBe("open-box");
    expect(conditionOf("Bose renewed QC").condition).toBe("refurbished");
    expect(conditionOf("QC Ultra black", "unclaimedbaggage.com").condition).toBe("used");
    expect(conditionOf("QC Ultra black").condition).toBeNull();
    expect(productTypes("QuietComfort Headphones + QC Earbuds Set")).toContain("bundle");
  });
  it("dedupes by store + product path", () => {
    const r = dedupe([{ domain: "bose.com", url: "https://www.bose.com/p/a.html?x=1", title: "A" }, { domain: "bose.com", url: "https://www.bose.com/p/a.html", title: "A" }, { domain: "bose.com", url: "https://www.bose.com/p/b.html", title: "B" }]);
    expect(r.removed).toBe(1);
  });
  it("condition=new drops unstated and used (round 4); brand_strict drops look-alikes", () => {
    const rows = [annotate({ title: "Bose QC", domain: "x.com" }, "Bose"), annotate({ title: "Used Bose QC", domain: "x.com" }, "Bose"), annotate({ title: "B0SE QC", domain: "y.com" }, "Bose")];
    expect(applyProductFilters(rows, { condition: "new" }).rows.length).toBe(0);
    expect(applyProductFilters(rows, { brand_strict: true }).rows.length).toBe(2);
  });
});

describe("validation, vocab and docs", () => {
  it("rejects placeholder ZIP 99999 on /landed and /offers", async () => {
    for (const u of ["/landed?q=headphones&zip=99999", "/offers?q=headphones&zip=99999", "/landed?q=headphones&zip=00000"]) {
      const r = await SELF.fetch("https://example.com" + u); expect(r.status, u).toBe(400);
      expect(await r.text()).toMatch(/placeholder|real 5-digit/);
    }
    expect((await SELF.fetch("https://example.com/landed?q=headphones&zip=66061")).status).toBe(200);
  });
  it("link is a pay code; btc_indirect is a /q filter", async () => {
    expect(PAY_CODES).toContain("link");
    expect(Q_BOOL_FILTERS).toContain("btc_indirect");
    expect((await SELF.fetch("https://example.com/q?pay=link&limit=1")).status).toBe(200);
    expect((await SELF.fetch("https://example.com/q?pay=stripe-link&limit=1")).status).toBe(200);
    expect((await SELF.fetch("https://example.com/q?btc_indirect=1&limit=5")).status).toBe(200);
    expect((await SELF.fetch("https://example.com/q?btc_indirect=2")).status).toBe(400);
    const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_merchants", arguments: { pay: "link", limit: 3 } } });
    expect(r.error).toBeUndefined();
  });
  it("llms.txt documents /landed and get_landed_price", async () => {
    const t = await (await SELF.fetch("https://example.com/llms.txt")).text();
    expect(t).toContain("/landed?zip="); expect(t).toContain("get_landed_price"); expect(t).toContain("btc_indirect=0|1");
  });
  it(".well-known/klickymart.json endpoints == openapi paths, schema 0.5", async () => {
    const j = await (await SELF.fetch("https://example.com/.well-known/klickymart.json")).json<any>();
    expect(Object.keys(j.endpoints).sort()).toEqual(Object.keys((buildOpenApi("https://example.com") as any).paths).sort());
    expect(j.endpoints["/landed"]).toMatch(/\/landed$/);
    expect(j.record_schema_version).toBe("0.5-draft");
    const m = await (await SELF.fetch("https://example.com/.well-known/mcp.json")).json<any>();
    expect(m.tools).toContain("get_landed_price");
  });
  it("/check returns a step list from the checkout map", async () => {
    const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "t" });
    const snap = rowsToSnapshot([...rows.values()], report.version, report.source);
    const row = snap.rows.find((r) => r.d === "bose.com")!;
    const c = checkoutOf(row, parseRaw(row.raw_json)) as any;
    expect(c.steps.length).toBeGreaterThan(0);
    expect(c.steps_count).toBe(c.steps.length);
  });
});

describe("never an empty body", () => {
  it("search_merchants with no matches says so", async () => {
    for (const args of [{ pay: "shop-pay", category: "electronics", ship_pre: 1 }, { category: "electronics", ship_pre: 1 }, { pay: "shop-pay" }]) {
      const r = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_merchants", arguments: args } });
      expect(r.result.content[0].text.trim().length, JSON.stringify(args)).toBeGreaterThan(0);
    }
  });
  it("every openapi GET route returns a non-empty body", async () => {
    const paths = Object.keys((buildOpenApi("https://example.com") as any).paths).filter((p) => !p.includes("{") && p !== "/mcp");
    for (const p of paths) {
      const r = await SELF.fetch(`https://example.com${p}${p === "/landed" ? "?zip=66061&q=x" : ""}`);
      if ([202, 204, 301, 302, 304].includes(r.status)) continue;
      expect((await r.text()).trim().length, p).toBeGreaterThan(0);
    }
  }, 30000);
  it("nonEmpty turns an empty JSON 200 into an explicit error", async () => {
    const r = await nonEmpty(new Response("", { headers: { "content-type": "application/json" } }), new Request("https://x/q"));
    expect(r.status).toBe(503); expect(((await r.json()) as any).error.code).toBe("empty_response");
  });
});

describe("live catalog paging (mocked fetch not available; unit of coverage note)", () => {
  it("/landed for a named store with no rows explains why", async () => {
    const j = await (await SELF.fetch("https://example.com/landed?zip=66061&q=headphones&domain=sonos.com")).json<any>();
    expect(j.count).toBe(0); expect(j.coverage_note).toMatch(/sonos\.com/);
  });
});

import { policyShip, landedFor } from "../src/landed";
import { querySnapshot, validateQueryParams } from "../src/query";
describe("shipping policy + indirect BTC (data v5)", () => {
  const getSnap = async () => { const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "t" }); return rowsToSnapshot([...rows.values()], report.version, report.source); };
  it("policyShip: threshold, region, no guessing, ambiguous 'free' ignored", () => {
    const p = { rules: [{ type: "free_over" as const, min_usd: 49, region: "US" }] };
    expect(policyShip(p, "KS", 203.99)?.usd).toBe(0);
    expect(policyShip(p, "KS", 20)).toBeNull();
    expect(policyShip({ rules: [{ type: "flat" as const, usd: 15.95, region: "US" }, { type: "per_region" as const, usd: 5, region: "AK-HI" }] }, "AK", 10)?.usd).toBe(5);
    expect(policyShip({ rules: [{ type: "free" as const, region: "US" }, { type: "free_over" as const, min_usd: 75, region: "US" }] }, "KS", 20)).toBeNull();
    expect(policyShip({ rules: [{ type: "calculated" as const, region: "US" }] }, "KS", 20)).toBeNull();
  });
  it("Bose $203.99 to 66061 gets a policy-derived landed total", async () => {
    const s = await getSnap(); const row = s.rows.find((r) => r.d === "bose.com")!;
    const l = landedFor(parseRaw(row.raw_json), "66061", 203.99) as any;
    expect(l.shipping.label).toBe("policy-derived"); expect(l.shipping.usd).toBe(0);
    expect(l.est_total).toBeCloseTo(221.76, 2); expect(l.est_total_label).toMatch(/policy-derived/);
  });
  it("Trezor is btc_indirect via Confirmo, not native; /q btc_indirect=1 finds it", async () => {
    const s = await getSnap(); const raw = parseRaw(s.rows.find((r) => r.d === "shop.trezor.io")!.raw_json) as any;
    expect(raw.pay).not.toContain("btc"); expect(raw.btc_indirect[0].via).toBe("confirmo");
    const v = validateQueryParams(new URLSearchParams("btc_indirect=1&limit=50")); if (!v.ok) throw new Error(v.message);
    expect(JSON.stringify(querySnapshot(s, v.params))).toContain("shop.trezor.io");
  });
  it("Bitrefill checkout mapped to the email step; nothing submitted", async () => {
    const s = await getSnap(); const cm = (parseRaw(s.rows.find((r) => r.d === "bitrefill.com")!.raw_json) as any).checkout_map;
    expect(cm.stage).toBe("checkout"); expect(cm.first_blocker.needs).toContain("email"); expect(cm.steps.length).toBe(5);
  });
});
describe("r2 production fixes", () => {
  it("live search sends price filter + page size to the catalog", async () => {
    const { liveCatalogSearch } = await import("../src/ucp-live");
    let sent: any = null;
    await liveCatalogSearch("coffee grinder", null, "https://x", (async (_u: unknown, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ result: { structuredContent: { products: [] } } })); }) as typeof fetch, undefined, { maxMinor: 15000, pageSize: 25 });
    expect(sent.params.arguments.catalog.filters.price.max).toBe(15000);
    expect(sent.params.arguments.catalog.pagination.limit).toBe(25);
  });
  it("brand on the brand's own store is ok; same title+price on one store dedupes", () => {
    expect(brandCheck("Bose QuietComfort", "QuietComfort Headphones + Airfly SE", "www.bose.com").brand_match).toBe("ok");
    expect(dedupe([{ domain: "u.com", url: "https://u.com/p/a-1", title: "QC Ultra", price: 199.99 }, { domain: "u.com", url: "https://u.com/p/a-2", title: "QC Ultra", price: 199.99 }]).removed).toBe(1);
  });
});
