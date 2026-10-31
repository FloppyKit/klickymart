import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { experienceTemplate, parseExperience, storeExperience } from "../src/experience";
import { aggregateCheckoutQuotes, applyCheckoutQuote, loadCheckoutQuotes, type QuoteRow } from "../src/checkout-quotes";

// Throwaway in-memory keys only; nothing is published.
const D = "rc-store.example";
const base = { preset: "checkout", domain: D, region: "660", price_seen: "40.00", shipping: "5.00", tax: "3.40", total: "48.40" };
const tagsOf = (r: ReturnType<typeof experienceTemplate>) => (r.ok ? (r.value as { unsigned_event: { tags: string[][] } }).unsigned_event.tags : []);

describe("build_experience_note preset=checkout", () => {
  it("fills basis/depth/shipping_source and tags the preset", () => {
    const r = experienceTemplate(base, null);
    expect(r.ok).toBe(true);
    const t = tagsOf(r);
    expect(t).toContainEqual(["basis", "visit"]); expect(t).toContainEqual(["depth", "payment"]); expect(t).toContainEqual(["shipping_source", "checkout"]);
    expect(t).toContainEqual(["preset", "checkout"]); expect(t).toContainEqual(["region", "660"]);
    expect(t.find((x) => x[0] === "amount" && x[1] === "price_seen")?.[2]).toBe("40.00");
  });
  it("rejects a full ZIP, a missing ZIP3, state-only, bad arithmetic, missing tax, basis=directory, estimated", () => {
    expect(experienceTemplate({ ...base, region: "66044" }, null)).toMatchObject({ ok: false, code: "region_too_precise" });
    expect(experienceTemplate({ ...base, region: undefined }, null)).toMatchObject({ ok: false, code: "missing_region" });
    expect(experienceTemplate({ ...base, region: "US-KS" }, null)).toMatchObject({ ok: false });
    expect(experienceTemplate({ ...base, total: "50.00" }, null)).toMatchObject({ ok: false, code: "arithmetic" });
    expect(experienceTemplate({ ...base, total: "48.41" }, null).ok).toBe(true);
    expect(experienceTemplate({ ...base, tax: undefined }, null)).toMatchObject({ ok: false, code: "missing_tax" });
    expect(experienceTemplate({ ...base, basis: "directory" }, null)).toMatchObject({ ok: false, code: "bad_basis" });
    expect(experienceTemplate({ ...base, estimated: "true" }, null)).toMatchObject({ ok: false, code: "bad_estimated" });
    expect(experienceTemplate({ ...base, preset: "other" }, null)).toMatchObject({ ok: false, code: "bad_preset" });
  });
});

const row = (pk: string, ship: number, tax: number, extra: Partial<QuoteRow> = {}): QuoteRow => ({ id: pk + "id", pubkey: pk, created_at: 1_790_000_000, price: 40, shipping: ship, tax, total: null, currency: "USD", region: "660", ...extra });
describe("aggregateCheckoutQuotes", () => {
  it("needs 2 independent agreeing keys; a seed is level 1 only", () => {
    expect(aggregateCheckoutQuotes(D, "660", [row("a", 5, 3.4)]).corroborated).toBe(false);
    const seeded = aggregateCheckoutQuotes(D, "660", [row("seed", 5, 3.4), row("a", 5, 3.4)], { seeds: new Set(["seed"]) });
    expect(seeded).toMatchObject({ corroborated: false, keys_counting: 1, seed_present: true });
    expect(seeded.notes.find((n) => n.pubkey === "seed")).toMatchObject({ level: "seed", counts: false });
    const two = aggregateCheckoutQuotes(D, "660", [row("seed", 5, 3.4), row("a", 5, 3.4), row("b", 5.1, 3.42)], { seeds: new Set(["seed"]) });
    expect(two).toMatchObject({ corroborated: true, keys_counting: 2 });
  });
  it("disagreement, arithmetic, tax outlier, owner and young keys do not count", () => {
    expect(aggregateCheckoutQuotes(D, "660", [row("a", 5, 3.4), row("b", 12, 3.4)]).corroborated).toBe(false);
    const g = aggregateCheckoutQuotes(D, "660", [row("a", 5, 3.4, { total: 60 }), row("b", 5, 30), row("c", 5, 3.4), row("o", 5, 3.4), row("y", 5, 3.4)], { owners: new Set(["o"]), aged: (pk) => pk !== "y" });
    expect(g.keys_counting).toBe(1);
    const fl = Object.fromEntries(g.notes.map((n) => [n.pubkey, n.flags.join(";")]));
    expect(fl.a).toMatch(/arithmetic/); expect(fl.b).toMatch(/outlier-tax/); expect(fl.o).toMatch(/owner/); expect(fl.y).toMatch(/new key/);
  });
  it("flags shipping over 3x the median and counts each key's latest note once", () => {
    const g = aggregateCheckoutQuotes(D, "660", [row("a", 5, 3.4), row("b", 5, 3.4), row("c", 50, 3.4), row("a", 9, 3.4, { id: "old", created_at: 1 })]);
    expect(g.notes.find((n) => n.pubkey === "c")!.flags.join()).toMatch(/outlier-shipping/);
    expect(g.notes.filter((n) => n.pubkey === "a")).toHaveLength(1);
    expect(g).toMatchObject({ corroborated: true, keys_counting: 2, median_shipping_usd: 5 });
  });
  it("applyCheckoutQuote drives est_total only when corroborated and no store quote", () => {
    const agg = aggregateCheckoutQuotes(D, "660", [row("a", 5, 3.4), row("b", 5, 3.4)]);
    const l: Record<string, unknown> = { item_price: 40, est_total: null };
    applyCheckoutQuote(l, agg, "x"); expect(l.est_total).toBe(48.4); expect(String(l.est_total_label)).toMatch(/2 independent/);
    const l2: Record<string, unknown> = { item_price: 40, est_total: 47, store_quote: {} }; applyCheckoutQuote(l2, agg, "x"); expect(l2.est_total).toBe(47);
    const l3: Record<string, unknown> = { item_price: 40, est_total: null }; applyCheckoutQuote(l3, aggregateCheckoutQuotes(D, "660", [row("a", 5, 3.4)]), "x");
    expect(l3.est_total).toBeNull(); expect((l3.agent_checkout_quotes as { status: string }).status).toMatch(/1 agent saw/);
  });
});

function sign(tags: string[][], sk = secp.utils.randomSecretKey()) {
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk));
  const ev = { pubkey, created_at: Math.floor(Date.now() / 1000), kind: 422, tags, content: "" };
  const id = nostrEventId(ev); return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
describe("D1 round trip (throwaway keys)", () => {
  it("two signed preset notes become a corroborated ZIP3 quote once keys are 7+ days old", async () => {
    for (let i = 0; i < 2; i++) {
      const t = tagsOf(experienceTemplate(base, null));
      const p = parseExperience(sign(t), (d) => d === D); expect(p.ok).toBe(true);
      if (p.ok) await storeExperience(env.DB, p.value, sign(t), { source: "post" });
    }
    const now = await loadCheckoutQuotes(env.DB, D, "660", new Set());
    expect(now?.corroborated).toBe(false); // keys are new
    const later = await loadCheckoutQuotes(env.DB, D, "660", new Set(), Date.now() + 8 * 86400_000);
    expect(later).toMatchObject({ corroborated: true, keys_counting: 2, median_tax_rate_pct: 8.5 });
  });
  it("/landed/notes validates and answers", async () => {
    expect((await SELF.fetch("https://klickymart.com/landed/notes?domain=x.com&zip3=66044")).status).toBe(400);
    const r = await SELF.fetch(`https://klickymart.com/landed/notes?domain=${D}&zip3=660`);
    expect(r.status).toBe(200); expect(((await r.json()) as { notes: unknown[] }).notes.length).toBeGreaterThanOrEqual(0);
  });
});
