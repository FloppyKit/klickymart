import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { policyShip, landedFor } from "../src/landed";
import { annotate, applyProductFilters, brandCheck, dedupe, productTypes } from "../src/product-quality";
import { guestFreeMin } from "../src/ship-rules";
import { findAlternatives } from "../src/alternatives";
import { findOffers, parseOffers } from "../src/offers";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { dedupe as dd } from "../src/product-quality";
import REAL from "../../../data/records.ndjson?raw";
import OFFERS from "../../../data/offers.ndjson?raw";
async function realSnap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}

const SKULL = { rules: [{ type: "free_over" as const, min_usd: 49.99, region: "US", quote: 'Skullcandy rewards loyalty program members, "Soundlab members", qualify for FREE STANDARD SHIPPING on orders with a subtotal greater than $49.99.' },
  { type: "flat" as const, usd: 20, region: "AK-HI", quote: "All orders to Alaska, Hawaii and Puerto Rico will cost $20 to ship" }], ships_us: true };

describe("r4 shipping", () => {
  it("member-only free shipping never applies to a guest", () => {
    expect(policyShip(SKULL, "KS", 159.99)).toBeNull();
    const l = landedFor({ ship_policy: SKULL }, "66061", 159.99) as Record<string, any>;
    expect(l.est_total).toBeNull();
    expect(l.shipping.label).toBe("unknown");
    expect(l.shipping_rules_not_for_guests[0].condition).toMatch(/member|loyalty/i);
    expect(guestFreeMin(SKULL.rules)).toBeNull();
  });
  it("store card falls back to the published policy (one shipping story)", () => {
    const l = landedFor({ ship_policy: { rules: [{ type: "free_over", min_usd: 49, region: "US", quote: "Orders of $49 or more." }], ships_us: true } }, "66061", 100) as Record<string, any>;
    expect(l.ships_us).toBe(true); expect(l.free_ship_min_usd).toBe(49); expect(l.est_total).not.toBeNull();
  });
  it("gift cards: not taxed at sale, digital delivery on gift-card stores; phone top-ups unknown", () => {
    const l = landedFor({ category: ["gift-cards"] }, "66061", 26.55, null, { giftCard: true, digital: true, title: "Apple Gift Card $25" }) as Record<string, any>;
    expect(l.est_tax).toBe(0); expect(l.shipping.usd).toBe(0); expect(l.est_total).toBe(26.55);
    expect((l.tax_policy as { status: string }).status).toBe("not-taxed");
    const p = landedFor({}, "66061", 25, null, { giftCard: true, title: "Mobile top-up $25" }) as Record<string, any>;
    expect(p.est_tax).toBeNull(); expect(p.est_total).toBeNull();
  });
  it("/landed: the $25 Bitrefill card matches gift card <= $25, with its fee price and a total; row shipping == landed shipping", async () => {
    const r = findOffers(parseOffers(OFFERS as string), await realSnap(), "https://example.com", { q: "gift card", zip: "66061", max_price: 27, limit: 100 }); // r5: max_price applies to price_with_fee ($26.55)
    if (!r.ok) throw new Error();
    const items = dd(applyProductFilters(r.body.items.map((i) => annotate(i as Record<string, any>, "gift card")), { type: "gift-card" }).rows).rows as Record<string, any>[];
    const b = { items };
    const c = b.items.find((i) => i.sku === "apple-usa:25");
    expect(c).toBeTruthy();
    expect(c!.price_with_fee).toBe(26.55);
    expect(c!.landed.est_total).toBe(26.55);
    for (const i of b.items) if (i.landed) expect(i.shipping).toEqual(i.landed.shipping);
  });
});

describe("r4 product filters", () => {
  it("over-ear vs earbuds", () => {
    expect(productTypes("Sony WH-1000XM5 Wireless Noise Canceling Headphones")).toEqual(["headphones"]);
    expect(productTypes("Sony WF-1000XM5 Truly Wireless Earbuds")).toEqual(["earbuds"]);
    expect(productTypes("Bose QuietComfort Ultra Earbuds", "https://bose.com/p/headphones/qc-ultra-earbuds")).toEqual(["earbuds"]);
    expect(productTypes("Over-Ear Wireless Headphones, in-ear fit kit")).toContain("headphones");
  });
  it("brand: own store, strict drops absent, look-alike in query flagged", () => {
    expect(brandCheck("Bose QuietComfort", "QuietComfort Headphones", "bose.com").brand_match).toBe("ok");
    expect(brandCheck("anc headphones", "QuietComfort Headphones", "bose.com")).toMatchObject({ brand_match: null, brand: "bose" });
    const rows = [annotate({ title: "QC Headphones", domain: "x.com" }, "Bose"), annotate({ title: "Bose QC", domain: "x.com" }, "Bose")];
    expect(applyProductFilters(rows, { brand_strict: true }).rows.length).toBe(1);
    const q = brandCheck("B0SE headphones", "B0SE QC45 headphones", "z.com");
    expect(q.brand_match).toBe("lookalike"); expect(q.query_lookalike).toMatch(/B0SE/);
  });
  it("condition=new keeps structured-data new, drops unknown", () => {
    const rows = [annotate({ title: "QC", domain: "x.com", condition: "new" }, "x"), annotate({ title: "QC", domain: "x.com" }, "x")];
    expect(applyProductFilters(rows, { condition: "new" }).rows.length).toBe(1);
  });
  it("dedupe collapses variants of one page but keeps gift-card denominations", () => {
    const v = [{ domain: "s.com", url: "https://s.com/products/wh?variant=1", title: "WH-1000XM5", price: 300 }, { domain: "s.com", url: "https://s.com/products/wh?variant=2", title: "WH-1000XM5 Black", price: 310 }, { domain: "s.com", url: "https://s.com/products/wh", title: "WH-1000XM5", price: 300 }];
    expect(dedupe(v).rows.length).toBe(1);
    const g = [10, 25].map((f) => ({ domain: "b.com", url: "https://b.com/apple", title: `Apple $${f}`, sku: `apple:${f}`, denomination: { face_usd: f } }));
    expect(dedupe(g).rows.length).toBe(2);
  });
});

describe("r4 btc", () => {
  it("trezor stays in bitcoin hardware results, labelled indirect", async () => {
    const a = findAlternatives(await realSnap(), "https://example.com", { category: "crypto-hardware", pay: "btc", limit: 50, include_indirect: true }); // r5: indirect only when asked
    if (!a.ok) throw new Error();
    const b = a.body as { items: { d: string; btc_route?: string }[] };
    const t = b.items.find((i) => i.d === "shop.trezor.io");
    expect(t?.btc_route).toBe("indirect");
    const firstIndirect = b.items.findIndex((i) => i.btc_route === "indirect");
    expect(b.items.slice(0, firstIndirect).every((i) => i.btc_route === "native")).toBe(true);
  });
});

describe("r4 check + docs", () => {
  it("/check?domains= batch (1-10)", async () => {
    const r = await SELF.fetch("https://example.com/check?domains=a.com,b.com");
    expect(r.status).toBe(200);
    expect((await r.json<{ count: number }>()).count).toBe(2);
    expect((await SELF.fetch("https://example.com/check?domains=" + Array.from({ length: 11 }, (_, i) => `s${i}.com`).join(","))).status).toBe(400);
  });
  it("checkout steps come from the checkout map (cryptocloaks)", async () => {
    const { checkoutOf } = await import("../src/explain");
    const snap = await realSnap(); const row = snap.rows.find((r) => r.d === "cryptocloaks.com")!;
    const c = checkoutOf(row, JSON.parse(row.raw_json));
    expect(c.steps_count).toBe(c.steps.length); expect(Array.isArray(c.steps)).toBe(true); expect(c.steps.length).toBeGreaterThan(3);
  });
  it("llms.txt describes every stop reason", async () => {
    const t = await (await SELF.fetch("https://example.com/llms.txt")).text();
    expect(t).toMatch(/no-checkout-button: /); expect(t).toMatch(/probe-error: /);
  });
});
describe("r4 bundle", () => { it("A + B titles are bundles", () => { expect(productTypes("QuietComfort Headphones + Airfly SE")).toContain("bundle"); }); });
