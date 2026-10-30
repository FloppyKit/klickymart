/** GO 5.7 round-1 (Deal Hunting) fixes. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import routerSrc from "../src/router.ts?raw";
import { queryTokens, offerTokens } from "../src/search-terms";
import { findAlternatives } from "../src/alternatives";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { querySnapshot, validateQueryParams } from "../src/query";
import REAL from "../../../data/records.ndjson?raw";
let SNAP: ReturnType<typeof rowsToSnapshot> | null = null;
async function realSnap() {
  if (SNAP) return SNAP;
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return (SNAP = rowsToSnapshot([...rows.values()], report.version, report.source));
}
const q = async (qs: string) => { const p = validateQueryParams(new URLSearchParams(qs)); if (!p.ok) throw new Error(p.message); return querySnapshot(await realSnap(), p.params); };

const j = async (u: string) => (await SELF.fetch(`https://example.com${u}`)).json<Record<string, any>>();

describe("round-1 fixes", () => {
  it("taxpre=1: count/total agree with items, and unknown is explained", async () => {
    const r = await j("/alternatives?category=electronics&zip=66061&taxpre=1&limit=50");
    expect(r.total).toBe(r.items.length);
    expect(r.count).toBe(r.items.length);
    for (const it of r.items) expect(it.landed.tax_shown_before_payment).toBe(true);
    expect(r.taxpre.note).toMatch(/observed|unknown/);
    expect((await SELF.fetch("https://example.com/alternatives?category=electronics&taxpre=1")).status).toBe(400);
  });
  it("pay=btc means on-chain: every item's pay list contains btc", async () => {
    const a = findAlternatives(await realSnap(), "https://example.com", { category: "crypto-hardware", pay: "btc", limit: 50 });
    if (!a.ok) throw new Error();
    const r = a.body as { items: { d: string; pay: string[] }[] };
    // Trezor is listed only because its pay list now has btc from its own FAQ quote (re-extracted, round 1).
    expect(r.items.length).toBeGreaterThan(0);
    for (const it of r.items) expect(it.pay).toContain("btc");
  });
  it("every cat code in llms.txt is accepted by /q (btcnative)", async () => {
    const txt = await (await SELF.fetch("https://example.com/llms.txt")).text();
    const line = txt.split("\n").find((l) => l.includes("store-type codes"))!;
    const codes = line.match(/codes, comma-separated: ([^)]*)\)/)![1].split(", ");
    expect(codes).toContain("btcnative");
    for (const c of codes) expect((await SELF.fetch(`https://example.com/q?cat=${c}&limit=1`)).status, c).toBe(200);
    expect((await q("cat=btcnative&limit=50")).items.length).toBeGreaterThan(20);
  });
  it("every router path appears in openapi.json", async () => {
    const spec = await j("/openapi.json");
    const paths = new Set(Object.keys(spec.paths));
    const routes = [...routerSrc.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(20);
    const missing = [...new Set(routes)].filter((p) => !paths.has(p));
    expect(missing).toEqual([]);
    for (const pre of [...routerSrc.matchAll(/path\.startsWith\("(\/[a-z]+\/)"\)/g)].map((m) => m[1]))
      expect([...paths].some((p) => p.startsWith(pre)), pre).toBe(true);
  });
  it("noise-cancelling / ANC / over-ear synonyms match offers and merchants", async () => {
    expect(queryTokens("noise-cancelling over-ear headphones")).toEqual(["anc", "overear", "headphones"].map((w) => w.replace(/s$/, "")));
    expect(offerTokens("QuietComfort Headphones", "Bose").has("anc")).toBe(true);
    for (const q of ["noise cancelling", "noise-cancelling headphones", "ANC headphones", "over-ear noise cancelling headphones"]) {
      const r = await j(`/offers?q=${encodeURIComponent(q)}`);
      expect(r.items.length, q).toBeGreaterThan(0);
    }
    expect((await q("q=noise%20cancelling%20headphones&limit=20")).items.map((i: { d: string }) => i.d)).toContain("bose.com");
  });
});

import { checkDomain } from "../src/check";
import { findOffers, parseOffers } from "../src/offers";
import { filterByDomain } from "../src/ucp-live";
import { landedFor } from "../src/landed";
import OFFERS from "../../../data/offers.ndjson?raw";

describe("round-1 batch 2 (Blair, Personal Shopper)", () => {
  it("unknown category -> 200, empty list, note, valid categories; handbag maps to apparel", async () => {
    const snap = await realSnap();
    const r = findAlternatives(snap, "https://x", { category: "zzz-unknown-thing" });
    expect(r.ok).toBe(true);
    const b = (r as { body: Record<string, any> }).body;
    expect(b.items).toEqual([]); expect(b.count).toBe(0); expect(b.valid_categories).toContain("electronics"); expect(b.note).toMatch(/no category/);
    const h = findAlternatives(snap, "https://x", { category: "handbag" }) as { ok: boolean; body: Record<string, any> };
    expect(h.ok).toBe(true); expect(h.body.categories).toEqual(["apparel"]);
  });
  it("/check, /alternatives and /offers agree on co, guest, btc for every store", async () => {
    const snap = await realSnap();
    const alt = new Map<string, any>();
    for (const c of ["electronics", "gift-cards", "groceries", "apparel", "hardware", "books", "travel", "crypto-hardware", "other"]) {
      const a = findAlternatives(snap, "https://x", { category: c, limit: 500 }) as { ok: boolean; body: { items: any[] } };
      for (const it of a.body.items) alt.set(it.d, it);
    }
    expect(alt.size).toBeGreaterThan(50);
    let n = 0;
    for (const [d, it] of alt) {
      const c = checkDomain(snap, d, "https://x") as { ok: boolean; body: Record<string, any> };
      expect(c.body.co, d).toBe(it.checkout); expect(c.body.checkout, d).toBe(it.checkout);
      expect(c.body.guest, d).toBe(it.guest); expect(c.body.btc_grade, d).toBe(it.btc_grade); expect(c.body.btc, d).toBe(it.btc_grade);
      expect(c.body.checkout_depth.co, d).toBe(it.checkout);
      n++;
    }
    const offers = parseOffers(OFFERS as string);
    const o = findOffers(offers, snap, "https://x", { q: "headphones", limit: 50 }) as { ok: true; body: { items: any[] } };
    for (const it of o.body.items) expect(it.store.checkout_depth, it.domain).toBe((checkDomain(snap, it.domain, "https://x") as any).body.co);
    expect(n).toBeGreaterThan(50);
  });
  it("live catalog domain filter keeps only that store's products", () => {
    const sc = { products: [{ title: "a", variants: [{ url: "https://www.sonos.com/x" }] }, { title: "b", variants: [{ url: "https://other.com/y" }] }, { title: "c", variants: [{ url: "https://shop.sonos.com/z" }] }] };
    const f = filterByDomain(sc, "sonos.com");
    expect((f.sc as typeof sc).products.map((p) => p.title)).toEqual(["a", "c"]); expect(f.dropped).toBe(1);
  });
  it("landed: total only when price, shipping and tax are all known; parts otherwise", () => {
    const withShip = landedFor({}, "66061", 100, { usd: 8 }) as Record<string, any>;
    expect(withShip.shipping.usd).toBe(8); expect(withShip.est_total).toBeCloseTo(100 + 8 + 8.71, 2);
    const noShip = landedFor({}, "66061", 100, null) as Record<string, any>;
    expect(noShip.shipping.usd).toBeNull(); expect(noShip.est_total).toBeNull(); expect(noShip.est_tax).toBeCloseTo(8.71, 2); expect(noShip.est_total_note).toMatch(/shipping/);
  });
  it("Bitrefill gift cards expose denominations; $25 gift card is findable", async () => {
    const snap = await realSnap();
    const o = findOffers(parseOffers(OFFERS as string), snap, "https://x", { q: "$25 gift card", domain: "bitrefill.com" }) as { ok: true; body: { items: any[] } };
    expect(o.body.items.length).toBeGreaterThan(0);
    expect(o.body.items[0].denomination.face_usd).toBe(25);
    expect(o.body.items[0].denomination.fee).toBeNull();
  });
  it("/check carries btc_indirect and grade range fields", async () => {
    const snap = await realSnap();
    const c = checkDomain(snap, "foundation.xyz", "https://x") as { body: Record<string, any> };
    expect(c.body).toHaveProperty("btc_indirect");
    expect(c.body.btc_grade_range).toBe("2-4");
  });
});
