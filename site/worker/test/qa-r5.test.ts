import { describe, expect, it } from "vitest";
import { landedFor } from "../src/landed";
import { annotate, applyProductFilters, conditionOf, dedupe, relevanceOf } from "../src/product-quality";
import { findAlternatives } from "../src/alternatives";
import { findOffers, parseOffers } from "../src/offers";
import { flagPriceOutliers, flagPrefix, flagRow } from "../src/row-flags";
import { experienceTemplate } from "../src/experience";
import { checkDomain } from "../src/check";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import REAL from "../../../data/records.ndjson?raw";
import OFFERS from "../../../data/offers.ndjson?raw";
async function realSnap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}
const A = "31420:" + "a".repeat(64) + ":bitrefill.com";

describe("r5 BTC filter semantics", () => {
  it("pay=btc matches native stores only; Trezor (Confirmo) only with include_indirect, labelled", async () => {
    const snap = await realSnap();
    const nat = findAlternatives(snap, "https://x", { category: "crypto-hardware", pay: "btc", limit: 50 });
    expect(nat.ok).toBe(true);
    const b = (nat as any).body;
    expect(b.items.map((i: any) => i.d)).not.toContain("shop.trezor.io");
    expect(b.items.every((i: any) => i.btc_route === "native")).toBe(true);
    expect(b.indirect_excluded).toContain("shop.trezor.io");
    const ind = (findAlternatives(snap, "https://x", { category: "crypto-hardware", pay: "btc", limit: 50, include_indirect: true }) as any).body;
    const t = ind.items.find((i: any) => i.d === "shop.trezor.io");
    expect(t.btc_route).toBe("indirect");
    expect(ind.items[ind.items.length - 1].d).toBe("shop.trezor.io");
  });
});

describe("r5 row flags", () => {
  it("blocked-tos rows are not usable, demoted, and the text line says so", () => {
    const blocked = { domain: "wacaco.com", price: 79.9, store: { indexed: true, verdict: "blocked-tos" } };
    const ok = { domain: "kaffeproducts.com", price: 29.99, store: { indexed: true, verdict: "reachable", checkout_stage: "checkout" } };
    expect(flagRow(blocked)).toBe(3); expect(flagRow(ok)).toBe(0);
    expect((blocked as any).agent_usable).toBe(false);
    expect(flagPrefix(blocked)).toMatch(/DO NOT USE: blocked-tos/);
  });
  it("price outliers: $6.24 grinder among $25-$150 grinders is flagged", () => {
    const rows: any[] = [6.24, 24.99, 29.99, 58.5, 72, 79.9, 89, 139.97].map((p, i) => ({ domain: `s${i}.com`, price: p, currency: "USD", product_type: ["grinder"] }));
    expect(flagPriceOutliers(rows)).toBe(1);
    expect(rows[0].price_flag).toMatch(/outlier/);
  });
  it("no-add-to-cart is flagged on the row", () => {
    const r: any = { domain: "focuscamera.com", price: 88, store: { indexed: true, verdict: "reachable", first_blocker: "no-add-to-cart" } };
    flagRow(r);
    expect(r.flags.join(" ")).toMatch(/no-add-to-cart/);
    expect(flagPrefix(r)).toMatch(/NO ADD-TO-CART/);
  });
});

describe("r5 product accuracy", () => {
  it("brand's own store means new; open-box stores; unknown stays its own option", () => {
    expect(conditionOf("Hesh 540 ANC", "skullcandy.com").condition).toBe("new");
    expect(conditionOf("Life Q20", "us.soundcore.com").condition).toBe("new");
    expect(conditionOf("Space One", "openbox-deals.com").condition).toBe("open-box");
    expect(conditionOf("Sony WH-1000XM5", "focuscamera.com").condition).toBeNull();
    const rows = [annotate({ title: "Hesh 540 ANC", domain: "skullcandy.com" }, "hesh"), annotate({ title: "Sony WH-1000XM5", domain: "focuscamera.com" }, "sony")];
    expect(applyProductFilters(rows, { condition: "new" }).rows.length).toBe(1);
    expect(applyProductFilters(rows, { condition: "new,unknown" }).rows.length).toBe(2);
    expect(applyProductFilters(rows, { condition: "unknown" }).rows[0]!.domain).toBe("focuscamera.com");
  });
  it("dedupe: focuscamera XM5 triple and colour pages collapse, other listings kept", () => {
    const t = (title: string, url: string) => ({ domain: "focuscamera.com", title, url, price: 298 });
    const d = dedupe([t("Sony WH-1000XM5 Wireless Noise Canceling Over-Ear Headphones (Black)", "https://focuscamera.com/products/a"),
      t("Sony WH-1000XM5 Wireless Noise Canceling Over-Ear Headphones Bundle (Black)", "https://focuscamera.com/products/b"),
      t("Sony WH-1000XM5 Wireless Noise Canceling Over-Ear Headphones (Black) Bundle", "https://focuscamera.com/products/c"),
      { domain: "2bgutm-1f.myshopify.com", title: "Bose QC35 II Gaming Headset - Black", url: "https://2bgutm-1f.myshopify.com/products/x", price: 249.55 },
      { domain: "2bgutm-1f.myshopify.com", title: "Bose QC35 II Gaming Headset - White", url: "https://2bgutm-1f.myshopify.com/products/y", price: 249.55 }]);
    expect(d.rows.length).toBe(2); expect(d.removed).toBe(3);
    expect((d.rows[0] as any).other_listings.length).toBe(2);
  });
  it("relevance floor: 'Hesh 540' drops perfume named 540, keeps Hesh", () => {
    expect(relevanceOf("Hesh 540", "Baccarat Rouge 540 Extrait Parfum").below_floor).toBe(true);
    expect(relevanceOf("Hesh 540", "540").below_floor).toBe(true);
    expect(relevanceOf("Hesh 540", "Skullcandy Hesh 540 ANC").below_floor).toBe(false);
    expect(relevanceOf("noise cancelling over-ear headphones", "JBuds Lux ANC Headphones Mauve").below_floor).toBe(false);
  });
});

describe("r5 fees", () => {
  it("gift card: price = price_with_fee when known; max_price applies to it; btc fee explicit unknown", async () => {
    const snap = await realSnap();
    const offers = parseOffers(OFFERS as string);
    const r = findOffers(offers, snap, "https://x", { q: "apple gift card", domain: "bitrefill.com", limit: 50 }) as any;
    const ten = r.body.items.find((i: any) => i.face_value === 10);
    expect(ten.price).toBe(ten.price_with_fee); expect(ten.price).toBeGreaterThan(10); expect(ten.fee).toBeGreaterThan(0);
    expect(ten.btc_fee).toBeNull(); expect(ten.btc_fee_note).toMatch(/unknown, not zero/);
    const capped = findOffers(offers, snap, "https://x", { q: "apple gift card", domain: "bitrefill.com", max_price: 25, limit: 50 }) as any;
    expect(capped.body.items.some((i: any) => i.face_value === 25)).toBe(false); // $26.55 with fee
    const amz = findOffers(offers, snap, "https://x", { q: "amazon gift card", domain: "bitrefill.com", limit: 5 }) as any;
    expect(amz.body.items[0].fee).toBeNull(); expect(amz.body.items[0].fee_status).toMatch(/unknown/);
    expect(amz.body.items[0].btc_route_for.domain).toBe("amazon.com");
  });
  it("untaxed total note does not mention estimated tax", () => {
    const l = landedFor({ category: ["gift-cards"] }, "66061", 26.55, null, { giftCard: true, digital: true, title: "Apple Gift Card $25" }) as any;
    expect(l.est_total_note).not.toMatch(/estimated tax/); expect(l.est_total_note).toMatch(/no sales tax/);
  });
});

describe("r5 /check", () => {
  it("steps is the step list; wallets agree with pay.all", async () => {
    const snap = await realSnap();
    const c = checkDomain(snap, "skullcandy.com", "https://x") as any;
    expect(Array.isArray(c.body.steps)).toBe(true);
    expect(c.body.steps_count).toBe(c.body.steps.length);
    if (c.body.pay.all.includes("spay")) expect(c.body.pay_shop_pay).toBe(true);
  });
});

describe("r5 notes", () => {
  it("basis omitted = unknown, does not count", () => {
    const t = experienceTemplate({ domain: "bitrefill.com", depth: "checkout" }, A) as any;
    expect(t.value.fields.basis).toBe("unknown"); expect(t.value.fields.counts_toward_chart).toBe(false);
    expect(t.value.unsigned_event.tags).toContainEqual(["basis", "unknown"]);
  });
  it("guest=yes is a 400 (only true|false|unknown)", () => {
    const t = experienceTemplate({ domain: "bitrefill.com", depth: "checkout", guest: "yes" }, A) as any;
    expect(t.ok).toBe(false); expect(t.code).toBe("bad_guest");
  });
  it("not-observed, price seen vs paid, fee, estimated, none-observed pay list", () => {
    const t = experienceTemplate({ domain: "bitrefill.com", depth: "paid", basis: "visit", shown_before_payment: "not-observed", price_seen: "25", price_paid: "26.55", fee: "1.55", tax: "0", estimated: "tax", pay_offered: [] }, A) as any;
    const tags = t.value.unsigned_event.tags;
    expect(tags).toContainEqual(["shown_before_payment", "tax", "not-observed"]);
    expect(tags).toContainEqual(["amount", "price_paid", "26.55", "USD"]);
    expect(tags).toContainEqual(["amount", "fee", "1.55", "USD"]);
    expect(tags).toContainEqual(["amount", "tax", "0", "USD", "estimated"]);
    expect(tags).toContainEqual(["pay_offered", "none-observed"]);
    expect(t.value.fields.pay_offered).toBe("none-observed");
    expect(t.value.fields.counts_toward_chart).toBe(true);
  });
});
