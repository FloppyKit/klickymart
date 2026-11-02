import { wipe } from "./helpers/wipe";
import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { cleanRules, deliveredField, deliveredPriceEnabled, loadShipPolicies, resetShipCache, withPolicy } from "../src/delivered";
import { findOffers, liveItems, type Offer } from "../src/offers";
import { rowsToSnapshot } from "../src/index-mem";

const NOW = 1_800_000_000;
const snap = rowsToSnapshot([{ d: "known.com", name: "k", raw_json: JSON.stringify({ d: "known.com", ship_policy: { rules: [{ type: "flat", usd: 3, quote: "Shipping is $3." }] } }) }] as never, "v", "t");
const offer = (d: string, p: number): Offer => ({ d, n: "Pasta 1 lb", p, c: "USD", u: `https://${d}/p`, me: "jsonld", src: `https://${d}/p`, t: "2026-11-01T00:00:00Z", st: "in" });
const items = (r: ReturnType<typeof findOffers>) => (r as { body: { items: Record<string, any>[] } }).body.items;
const POL = new Map([["obs.com", { rules: [{ type: "free_over" as const, min_usd: 50, quote: "Free shipping over $50." }, { type: "flat" as const, usd: 5.99, quote: "Otherwise $5.99." }] }]]);

describe("delivered price (KM_DELIVERED_PRICE)", () => {
  it("default off", () => { expect(deliveredPriceEnabled({})).toBe(false); expect(deliveredPriceEnabled({ KM_DELIVERED_PRICE: "on" })).toBe(true); });
  it("flag off (no policies map): rows unchanged, no delivered field", () => {
    const it0 = items(findOffers([offer("obs.com", 10)], snap, "https://x", { q: "pasta", zip: "66061" }))[0]!;
    expect(it0).not.toHaveProperty("delivered");
  });
  it("observed policy prices a store with no record; delivered = price + shipping + tax", () => {
    const it0 = items(findOffers([offer("obs.com", 10)], snap, "https://x", { q: "pasta", zip: "66061" }, null, POL))[0]!;
    expect(it0.delivered).toMatchObject({ zip: "66061", label: "policy-derived", parts: { price: 10, shipping: 5.99 } });
    expect(it0.delivered.usd).toBeCloseTo(10 + 5.99 + it0.delivered.parts.tax, 2);
    const big = items(findOffers([offer("obs.com", 60)], snap, "https://x", { q: "pasta", zip: "66061" }, null, POL))[0]!;
    expect(big.delivered.parts.shipping).toBe(0);
  });
  it("the store's own record policy wins over an observed one", () => {
    const it0 = items(findOffers([offer("known.com", 10)], snap, "https://x", { q: "pasta", zip: "66061" }, null, new Map([["known.com", POL.get("obs.com")!]])))[0]!;
    expect(it0.delivered.parts.shipping).toBe(3);
  });
  it("unknown policy, calculated-at-checkout or no ZIP -> shipping unknown, usd null (never guessed)", () => {
    const calc = new Map([["c.com", { rules: [{ type: "calculated" as const, quote: "Calculated at checkout." }] }]]);
    for (const [d, pol, zip] of [["none.com", POL, "66061"], ["c.com", calc, "66061"], ["obs.com", POL, undefined]] as const) {
      const it0 = items(findOffers([offer(d, 10)], snap, "https://x", { q: "pasta", zip: zip ?? null }, null, pol as never))[0]!;
      expect(it0.delivered).toMatchObject({ usd: null, label: "shipping unknown" });
    }
  });
  it("member-only rules never price a guest", () => {
    const m = new Map([["m.com", { rules: [{ type: "free" as const, quote: "Rewards members get free shipping.", conditions: 'conditional: "members"' }] }]]);
    expect(items(findOffers([offer("m.com", 10)], snap, "https://x", { q: "pasta", zip: "66061" }, null, m as never))[0]!.delivered.usd).toBeNull();
  });
  it("live catalog rows get the observed policy too", () => {
    const li = liveItems([{ title: "Pasta", variants: [{ price: { amount: 1000, currency: "USD" }, url: "https://obs.com/products/p", availability: { available: true } }] }] as never, snap, "https://x", { q: "pasta", zip: "66061" }, null, POL);
    expect(li.items[0]!.delivered).toMatchObject({ label: "policy-derived", parts: { shipping: 5.99 } });
  });
  it("cleanRules drops unquoted or unpriced rules; withPolicy leaves records with a policy alone", () => {
    expect(cleanRules([{ type: "flat", usd: 4 }, { type: "flat", quote: "x" }, { type: "free_over", min_usd: 20, quote: "q" }, { type: "guess", quote: "q" }])).toHaveLength(1);
    const raw = { ship_policy: { rules: [{ type: "free", quote: "q" }] } };
    expect(withPolicy(raw, "obs.com", POL)).toBe(raw);
    expect(deliveredField(undefined, "66061")).toMatchObject({ usd: null, label: "shipping unknown" });
  });
});

describe("ship_policy_obs (D1)", () => {
  beforeEach(async () => { resetShipCache(); await wipe(env.DB, ["ship_policy_obs"]); });
  it("latest row per domain wins; [] rows mean unknown; flag off -> null", async () => {
    const ins = (id: string, d: string, rules: unknown, at: number) => env.DB.prepare("INSERT INTO ship_policy_obs (id, domain, rules_json, ships_us, src, checked_at) VALUES (?,?,?,?,?,?)").bind(id, d, JSON.stringify(rules), 1, `https://${d}/policies/shipping-policy`, at).run();
    await ins("1", "a.com", [{ type: "flat", usd: 9, quote: "Shipping is $9." }], NOW - 100);
    await ins("2", "a.com", [{ type: "flat", usd: 4, quote: "Shipping is $4." }], NOW);
    await ins("3", "b.com", [], NOW);
    expect(await loadShipPolicies({ DB: env.DB }, NOW)).toBeNull();
    const m = (await loadShipPolicies({ DB: env.DB, KM_DELIVERED_PRICE: "on" }, NOW))!;
    expect(m.get("a.com")!.rules[0]!.usd).toBe(4); expect(m.has("b.com")).toBe(false);
  });
});
