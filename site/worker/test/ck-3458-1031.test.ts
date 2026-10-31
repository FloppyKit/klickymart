import { describe, expect, it } from "vitest";
import { aggregateCheckoutQuotes, applyQuotesToRows, isoWeek, publicQuoteView, quoteSeedKeys, validZip3, SITE_ZAP_PUBKEY_HEX_DEFAULT, type CheckoutQuoteAgg, type QuoteRow } from "../src/checkout-quotes";
import { FACILITATOR_PUBKEY } from "../src/facilitate";

const agg = (over: Partial<CheckoutQuoteAgg> = {}): CheckoutQuoteAgg => ({ d: "a.example", zip3: "660", state: "KS", keys_counting: 3, seed_present: false, corroborated: true, median_shipping_usd: 50, median_tax_rate_pct: 8.5, status: "ok", notes: [], rules: "", ...over });
const row = (d: string, indexed = true) => ({ d, domain: d, price: 10, store: { indexed }, landed: { item_price: 10, est_total: 11 } as Record<string, unknown> });

describe("CK-3 indexed only", () => {
  it("skips unindexed stores", async () => {
    const rows = [row("a.example"), row("b.example", false), row("c.example")];
    const loaded: string[] = [];
    await applyQuotesToRows(rows, "660", (d) => d !== "c.example", async (d) => { loaded.push(d); return agg({ d }); }, (d) => d);
    expect(loaded).toEqual(["a.example"]);
    expect(rows[0]!.landed.est_total).toBe(60.85);
    expect(rows[1]!.landed.est_total).toBe(11); expect(rows[2]!.landed.est_total).toBe(11);
  });
});

describe("CK-4 quotes applied before filter/sort (shared path)", () => {
  it("rewritten est_total is visible to a later budget filter", async () => {
    const rows = [row("a.example")];
    await applyQuotesToRows(rows, "660", () => true, async () => agg(), () => "");
    expect(rows.filter((i) => (i.landed.est_total as number) <= 20)).toHaveLength(0);
  });
  it("router calls the shared path inside landedCall before max_landed", async () => {
    const src = (await import("../src/router.ts?raw")).default as string;
    const lc = src.slice(src.indexOf("const landedCall"), src.indexOf("const outliers = flagPriceOutliers(rows)"));
    expect(lc.indexOf("await attachCheckoutQuotes(rows, zip)")).toBeGreaterThan(-1);
    expect(lc.indexOf("await attachCheckoutQuotes(rows, zip)")).toBeLessThan(lc.indexOf("if (ml !== undefined)"));
  });
});

describe("CK-5 seeds", () => {
  it("includes site zap, facilitator, crawler; lowercases; ignores junk", () => {
    const s = quoteSeedKeys("AB".repeat(32), undefined, "nope");
    expect([...s].sort()).toEqual(["ab".repeat(32), FACILITATOR_PUBKEY, SITE_ZAP_PUBKEY_HEX_DEFAULT].sort());
  });
  it("seed notes never count toward the 3 keys and show seed (level 1)", () => {
    const now = 1_790_000_000; const seeds = quoteSeedKeys("aa".repeat(32));
    const rows: QuoteRow[] = [SITE_ZAP_PUBKEY_HEX_DEFAULT, FACILITATOR_PUBKEY, "aa".repeat(32), "bb".repeat(32), "cc".repeat(32)].map((pk, i) => ({ id: "n" + i, pubkey: pk, created_at: now - i, price: 100, shipping: 5, tax: 8, total: 113, currency: "USD", region: "660" }));
    const a = aggregateCheckoutQuotes("a.example", "660", rows, { seeds, nowS: now });
    expect(a.keys_counting).toBe(2); expect(a.corroborated).toBe(false); expect(a.seed_present).toBe(true);
    const v = publicQuoteView(a, new Map());
    expect(v.notes.filter((n) => n.level_label === "seed (level 1)")).toHaveLength(3);
  });
});

describe("CK-8 coarse drill-down", () => {
  it("week, $5 subtotal, 1-dp rate, no exact tax/total, pubkey kept", () => {
    const a = aggregateCheckoutQuotes("a.example", "660", [{ id: "x", pubkey: "dd".repeat(32), created_at: 1_793_000_000, price: 123.45, shipping: 5, tax: 10.30, total: 138.75, currency: "USD", region: "660" }]);
    const n = publicQuoteView(a, new Map([["x", 1_793_000_000]])).notes[0]! as Record<string, unknown>;
    expect(n.week).toBe(isoWeek(1_793_000_000)); expect(n.week).toMatch(/^\d{4}-W\d{2}$/);
    expect(n.day).toBeUndefined(); expect(n.tax).toBeUndefined(); expect(n.total).toBeUndefined(); expect(n.price).toBeUndefined();
    expect(n.subtotal_approx_usd).toBe(125); expect(n.tax_rate_pct).toBe(8.3); expect(n.pubkey).toBe("dd".repeat(32));
  });
  it("isoWeek", () => { expect(isoWeek(Date.UTC(2026, 9, 31) / 1000)).toBe("2026-W44"); expect(isoWeek(Date.UTC(2021, 0, 1) / 1000)).toBe("2020-W53"); });
  it("rejects unassigned zip3", () => { for (const z of ["000", "001", "004"]) expect(validZip3(z)).toBe(false); expect(validZip3("660")).toBe(true); expect(validZip3("66")).toBe(false); });
});
