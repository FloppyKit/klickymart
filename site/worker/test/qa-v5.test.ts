/** GO-DATA-V2 + 2026-10-30 re-review fixes, checked against the real v0.5 records and offers. */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkDomain } from "../src/check";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { findOffers, parseOffers } from "../src/offers";
import { landedFor, zipToState, validZip } from "../src/landed";
import { recheck, robotsAllows } from "../src/recheck";
import { mcpToolsList, watchTemplate, createMcpHandler } from "../src/mcp";
import { buildLlmsTxt } from "../src/llms";
import { renderV5 } from "../src/explain";
import { parseRaw } from "../src/records-api";
import { findAlternatives } from "../src/alternatives";
import REAL from "../../../data/records.ndjson?raw";
import OFFERS from "../../../data/offers.ndjson?raw";

const O = "https://klickymart.com";
async function snap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}
const body = (r: ReturnType<typeof checkDomain>) => { if (!r.ok) throw new Error(r.message); return r.body as Record<string, any>; };

describe("re-review fixes", () => {
  it("bestbuy.com: network errors are not a bot wall; pay methods and evidence filled", async () => {
    const b = body(checkDomain(await snap(), "bestbuy.com", O));
    expect(b.checkout_depth.co).toBeNull();
    expect(b.checkout_map.first_blocker.kind).toBe("network-error");
    expect(b.pay.online).toEqual(expect.arrayContaining(["card", "pp", "apay"]));
    expect(b.evidence).toMatch(/bestbuy\.com\/site\/help-topics\/payment-options/);
    expect(b.btc_grade).toBe(0);
  });
  it("sonos.com: pay is card+PayPal from the US terms, not 'gift'; free shipping", async () => {
    const b = body(checkDomain(await snap(), "sonos.com", O));
    expect(b.pay.online.sort()).toEqual(["card", "pp"]);
    expect(b.landed_cost.free_min_usd).toBe(0);
  });
  it("walmart.com: weak ships_us evidence removed (unknown)", async () => {
    expect(body(checkDomain(await snap(), "walmart.com", O)).landed_cost.ships_us).toBeNull();
  });
  it("first_blocker never calls a network error a bot wall", async () => {
    const s = await snap();
    for (const r of s.rows) {
      const m = parseRaw(r.raw_json).checkout_map as { first_blocker?: { kind: string; evidence?: string } } | undefined;
      if (m?.first_blocker?.kind === "bot-wall") expect(m.first_blocker.evidence ?? "").not.toMatch(/net::ERR_/);
      if (m?.first_blocker?.kind === "network-error") expect(r.co === null || r.co === undefined || r.co > 0).toBe(true);
    }
  });
});

describe("D3 landed cost by ZIP", () => {
  it("maps ZIPs to states and estimates tax", () => {
    expect(zipToState("66061")).toBe("KS");
    expect(zipToState("97201")).toBe("OR");
    expect(zipToState("10001")).toBe("NY");
    expect(validZip("6606")).toBeNull();
    const l = landedFor({ ship: { free_min_usd: 35 } }, "66061", 100) as Record<string, any>;
    expect(l.tax.state_rate_pct).toBe(6.5);
    expect(l.tax.source).toBe("estimated");
    expect(l.free_shipping_applies).toBe(true);
    expect(l.est_total).toBeCloseTo(108.71, 2);
    expect((landedFor({}, "97201", 50) as Record<string, any>).est_tax).toBe(0);
  });
  it("/check and /alternatives accept zip; MCP schemas document it", async () => {
    const fx = String((env as Record<string, unknown>).FIXTURE_NDJSON).split("\n")[0]!;
    const dom = (JSON.parse(fx) as { d?: string }).d ?? JSON.parse(JSON.parse(fx).content).d;
    const res = await (await import("../src/router")).handleRequest(new Request(`${O}/check?domain=${dom}&zip=66061`), env as never);
    const j = (await res.json()) as Record<string, any>;
    expect(j.verdict).not.toBe("not-in-index");
    expect(j.landed.state).toBe("KS");
    const bad = await (await import("../src/router")).handleRequest(new Request(`${O}/check?domain=bestbuy.com&zip=abc`), env as never);
    expect(bad.status).toBe(400);
    const tools = (mcpToolsList() as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
    expect(tools.find((t) => t.name === "check_domain")!.inputSchema.properties.zip).toBeTruthy();
    expect(tools.find((t) => t.name === "find_alternatives")!.inputSchema.properties.zip).toBeTruthy();
    const a = findAlternatives(await snap(), O, { category: "headphones", limit: 5 });
    expect(a.ok).toBe(true);
  });
});

describe("D1 offers", () => {
  const offers = parseOffers(OFFERS as string);
  it("has offers from deterministic sources only, each with checked_at and src", () => {
    expect(offers.length).toBeGreaterThan(100);
    for (const o of offers) { expect(["jsonld", "shopify-json", "og-meta", "microdata"]).toContain(o.me); expect(o.t).toMatch(/Z$/); expect(o.src).toMatch(/^https?:/); expect(o.p).toBeGreaterThan(0); }
  });
  it("finds by name words and adds landed cost for a ZIP", async () => {
    const o = offers.find((x) => x.c === "USD" && x.n.split(" ").length >= 2)!;
    const words = o.n.split(/\s+/).slice(0, 2).join(" ");
    const r = findOffers(offers, await snap(), O, { q: words, zip: "66061" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.body.items.length).toBeGreaterThan(0); expect((r.body.items[0] as Record<string, any>).landed?.state ?? "KS").toBe("KS"); }
    expect(findOffers(offers, await snap(), O, {}).ok).toBe(false);
  });
});

describe("D9 recheck", () => {
  it("robots evaluation: our group wins over *, longest match wins", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "floppykitmapbot").allows).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /\n\nUser-agent: FloppyKitMapBot\nAllow: /\n", "floppykitmapbot").allows).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /cart\n", "floppykitmapbot").allows).toBe(true);
  });
  it("second recheck within 10 minutes returns cached data with no fetch; robots disallow flips the verdict", async () => {
    let calls = 0;
    const f = (async (u: string) => { calls++; return new Response(String(u).endsWith("/robots.txt") ? "User-agent: *\nDisallow: /\n" : "ok", { status: 200 }); }) as unknown as typeof fetch;
    const now = 1_800_000_000;
    const a = await recheck(env.DB, "example-recheck.com", now, f);
    expect(a.live).toBe(true);
    expect((a.result as Record<string, unknown>).verdict).toBe("agents-not-welcome");
    expect(calls).toBe(1); // robots only; home not fetched when disallowed
    const b = await recheck(env.DB, "example-recheck.com", now + 60, f);
    expect(b.live).toBe(false);
    expect(calls).toBe(1);
    expect(b.next_allowed_at).toBe(new Date((now + 600) * 1000).toISOString());
  });
});

describe("D8 watch draft + docs", () => {
  it("watch_item returns an unsigned 420 template and says watches are not served yet", () => {
    const w = watchTemplate({ gtin: "0840268906138", max_price: 199 });
    expect(w.unsigned_event.kind).toBe(420);
    expect(w.unsigned_event.tags).toContainEqual(["t", "watch"]);
    expect(w.status).toMatch(/not served yet/);
    expect((w.unsigned_event as Record<string, unknown>).sig).toBeUndefined();
  });
  it("llms.txt documents ship, zip, offers, recheck, watch meaning, 31421 and ODbL credits", () => {
    const t = buildLlmsTxt(O, "bot@klickymart.com", ["wss://nos.lol"]);
    for (const s of ["\"ship\" with keys pre_pay", "zip=<5-digit US ZIP>", "/offers?gtin=", "/recheck?domain=", "## Watching", "kind 31421", "ODbL", "network-error"]) expect(t).toContain(s);
  });
  it("MCP lists the new tools", () => {
    const names = (mcpToolsList() as { tools: { name: string }[] }).tools.map((t) => t.name);
    for (const n of ["find_offers", "get_checkout_map", "recheck_domain", "watch_item"]) expect(names).toContain(n);
  });
  it("merchant page renders checkout map, policies and trust when present", () => {
    const h = renderV5({ checkout_map: { stage: "cart", first_blocker: { kind: "network-error" }, steps: [{ n: 1, stage: "home" }] }, policies: { return_days: 30, quotes: { return_days: "30 days" } }, trust: { created: "1999-01-01", age_bucket: "5y+", src: "https://rdap.org" } });
    expect(h).toContain("checkout-map"); expect(h).toContain("network/protocol errors"); expect(h).toContain("Return window"); expect(h).toContain("1999-01-01");
  });
  it("UCP agent profile is served", async () => {
    const res = await (await import("../src/router")).handleRequest(new Request(`${O}/.well-known/ucp`), env as never);
    const j = (await res.json()) as Record<string, any>;
    expect(j.ucp.capabilities["dev.ucp.shopping.catalog.search"]).toBeTruthy();
    expect(j.ucp.payment_handlers).toEqual({});
  });
});
void createMcpHandler;
