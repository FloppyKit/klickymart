import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { aggregate, coarseRegion, experienceTemplate, loadAggregates, parseExperience, proofWeight, storeExperience } from "../src/experience";

// Locally generated throwaway keys only; nothing here is published anywhere.
const D = "store.google.com";
const known = (d: string) => d === D;
function sign(kind: number, tags: string[][], content = "Guest checkout reached payment.", sk = secp.utils.randomSecretKey(), created_at = Math.floor(Date.now() / 1000)) {
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk));
  const ev = { pubkey, created_at, kind, tags, content };
  const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const exp = (extra: string[][] = []) => [["r", D], ["depth", "payment"], ["guest", "yes"], ["pay_used", "lightning"], ["pay_offered", "card", "lightning"], ["shown_before_payment", "tax", "yes"], ["amount", "shipping", "5.00", "USD"], ["amount", "total", "54.27", "USD"], ["region", "660"], ...extra];

describe("parseExperience", () => {
  it("parses a structured 422", () => {
    const r = parseExperience(sign(422, exp([["order_hash", "a".repeat(64)]])), known);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ d: D, depth: "payment", guest: "yes", tax_before: "yes", shipping: 5, total: 54.27, currency: "USD", region: "660", proof: "order_hash", structured: true });
  });
  it("rejects precise locations, bad depth, tampering, secrets", () => {
    expect(parseExperience(sign(422, exp().filter((t) => t[0] !== "region").concat([["region", "66044"]])), known)).toMatchObject({ ok: false, code: "region_too_precise" });
    expect(coarseRegion("66044").ok).toBe(false);
    expect(coarseRegion("US-KS")).toMatchObject({ ok: true, value: "US-KS" });
    expect(parseExperience(sign(422, [["r", D], ["depth", "teleported"]]), known)).toMatchObject({ code: "bad_depth" });
    const t = sign(422, exp()); t.content = "x";
    expect(parseExperience(t, known)).toMatchObject({ code: "bad_signature" });
    expect(parseExperience({ ...sign(422, exp()), nsec: "nsec1x" }, known)).toMatchObject({ code: "secret_sent" });
  });
  it("accepts kind 1 #klickymart as unstructured, rejects without the hashtag", () => {
    const r = parseExperience(sign(1, [["t", "klickymart"], ["r", D]], "Checkout wanted an account."), known);
    expect(r.ok && r.value.structured).toBe(false);
    expect(parseExperience(sign(1, [["r", D]]), known)).toMatchObject({ code: "missing_hashtag" });
  });
});

describe("aggregate", () => {
  it("needs 2 keys to corroborate and weighs proofs more", () => {
    const one = parseExperience(sign(422, exp()), known); if (!one.ok) throw 0;
    expect(aggregate(D, [{ ...one.value, proof_status: null } as never]).corroborated).toBe(false);
    const bad = parseExperience(sign(422, [["r", D], ["depth", "cart"], ["blocker", "captcha"]]), known); if (!bad.ok) throw 0;
    const proved = parseExperience(sign(422, exp([["order_hash", "b".repeat(64)]])), known); if (!proved.ok) throw 0;
    const a = aggregate(D, [{ ...bad.value, proof_status: null }, { ...proved.value, proof_status: null }] as never);
    expect(a.corroborated).toBe(true);
    expect(a.success_score).toBeGreaterThan(0.5); // proof note weighs 2 vs 1
    expect(proofWeight("order_hash", null)).toBe(2);
    expect(proofWeight(null, null)).toBe(1);
  });
});

describe("template", () => {
  it("is unsigned, carries privacy guidance, refuses full ZIPs", () => {
    const t = experienceTemplate({ domain: D, depth: "payment", region: "660", pay_used: "lightning" }, "31420:" + "a".repeat(64) + ":" + D);
    expect(t.ok).toBe(true);
    if (t.ok) { const ev = t.value.unsigned_event as Record<string, unknown>; expect(ev.kind).toBe(422); expect(ev.sig).toBeUndefined(); expect(ev.id).toBeUndefined(); expect(JSON.stringify(t.value)).toMatch(/site-specific/i); }
    expect(experienceTemplate({ domain: D, depth: "payment", region: "66044" }, null).ok).toBe(false);
  });
});

describe("routes", () => {
  const post = (ev: unknown) => SELF.fetch("https://example.com/reviews", { method: "POST", body: JSON.stringify(ev), headers: { "Content-Type": "application/json" } });
  it("POST /reviews stores experiences; chart and check show community data beside crawl", async () => {
    expect((await post(sign(422, exp()))).status).toBe(201);
    expect((await post(sign(422, exp([["preimage", "c".repeat(64)]])))).status).toBe(201);
    expect((await post(sign(1, [["t", "klickymart"], ["r", D]], "smooth"))).status).toBe(201);
    expect((await post(sign(422, exp().filter((t) => t[0] !== "region").concat([["region", "66044"]])))).status).toBe(400);
    const aggs = await loadAggregates(env.DB, [D]);
    expect(aggs.get(D)?.keys).toBe(3);
    const ch = await (await SELF.fetch("https://example.com/chart.json?limit=500")).json<{ items: { d: string; score_source: string; values: Record<string, { source: string }> }[] }>();
    const row = ch.items.find((i) => i.d === D)!;
    expect(row.score_source).toBe("community");
    expect(row.values.checkout_depth_crawl.source).toBe("crawl");
    const chk = await (await SELF.fetch(`https://example.com/check?domain=${D}`)).json<{ community_experience: { keys: number } }>();
    expect(chk.community_experience.keys).toBe(3);
    expect((await (await SELF.fetch("https://example.com/chart")).text())).toContain("Store chart");
    expect((await (await SELF.fetch("https://example.com/report")).text())).toContain("site-specific");
    const tpl = await SELF.fetch(`https://example.com/report/template?domain=${D}&depth=cart&region=US-KS`);
    expect(tpl.status).toBe(200);
  });
  it("stores relay-sourced experiences idempotently", async () => {
    const r = parseExperience(sign(422, exp()), known); if (!r.ok) throw 0;
    expect(await storeExperience(env.DB, r.value, {}, { source: "relay", relays: "wss://x" })).toBe("stored");
    expect(await storeExperience(env.DB, r.value, {}, { source: "relay", relays: "wss://x" })).toBe("duplicate");
  });
});
