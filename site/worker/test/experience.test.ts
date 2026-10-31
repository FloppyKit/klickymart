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
const exp = (extra: string[][] = []) => [["r", D], ["basis", "visit"], ["depth", "payment"], ["guest", "yes"], ["pay_used", "lightning"], ["pay_offered", "card", "lightning"], ["shown_before_payment", "tax", "yes"], ["amount", "shipping", "5.00", "USD"], ["amount", "total", "54.27", "USD"], ["region", "660"], ...extra];

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
    expect((await post(sign(1, [["t", "klickymart"], ["r", D], ["basis", "visit"]], "smooth"))).status).toBe(201);
    expect((await post(sign(422, exp().filter((t) => t[0] !== "region").concat([["region", "66044"]])))).status).toBe(400);
    expect((await loadAggregates(env.DB, [D])).get(D)).toBeUndefined(); // KM-007: keys seen < 7 days ago don't count yet
    await env.DB.batch(["UPDATE experiences SET received_day = '2026-01-01'", "UPDATE nostr_events SET first_seen = 1", "UPDATE reviews SET received_day = '2026-01-01'"].map((q) => env.DB.prepare(q)));
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

describe("r3 note fixes", () => {
  const T = (a: Record<string, unknown>) => experienceTemplate({ domain: D, ...a }, null);
  const tagsOf = (r: ReturnType<typeof T>) => (r.ok ? ((r.value.unsigned_event as { tags: string[][] }).tags) : []);
  it("carries shown_before_payment, tri-state, incl. none and unknown", () => {
    expect(tagsOf(T({ depth: "payment", shown_before_payment: "tax" }))).toContainEqual(["shown_before_payment", "tax", "true"]);
    expect(tagsOf(T({ depth: "payment", shown_before_payment: "tax" }))).toContainEqual(["shown_before_payment", "shipping", "unknown"]);
    expect(tagsOf(T({ depth: "payment", shown_before_payment: "none" }))).toContainEqual(["shown_before_payment", "tax", "false"]);
    const p = parseExperience(sign(422, [["r", D], ["depth", "payment"], ["shown_before_payment", "tax", "false"], ["shown_before_payment", "shipping", "unknown"]]), known);
    expect(p.ok && [p.value.tax_before, p.value.ship_before]).toEqual(["no", null]);
  });
  it("validates guest; same boolean on web and MCP", async () => {
    expect(T({ depth: "cart", guest: "1" })).toMatchObject({ ok: false, code: "bad_guest" });
    expect(T({ depth: "cart", guest: "yes" })).toMatchObject({ ok: false, code: "bad_guest" }); // r5: only true|false|unknown, as documented
    const r = T({ depth: "cart", guest: "true" }); expect(r.ok && (r.value.fields as { guest: boolean }).guest).toBe(true);
    expect(tagsOf(r)).toContainEqual(["guest", "true"]);
    const web = await SELF.fetch(`https://example.com/report/template?domain=${D}&depth=cart&guest=1`);
    expect(web.status).toBe(400);
    const ok = await (await SELF.fetch(`https://example.com/report/template?domain=${D}&depth=cart&guest=true`)).json<{ fields: { guest: unknown } }>();
    expect(ok.fields.guest).toBe(true);
    const mcp = await (await SELF.fetch("https://example.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "build_experience_note", arguments: { domain: D, depth: "cart", guest: "1" } } }) })).text();
    expect(mcp).toContain("-32602");
  });
  it("rating 1-5 and attempt filled automatically; attempt accepted as alias", () => {
    const r = T({ depth: "payment", rating: "4" });
    expect(tagsOf(r)).toContainEqual(["rating", "4", "5"]);
    expect(tagsOf(r)).toContainEqual(["attempt", "checkout"]);
    expect(T({ depth: "cart", rating: "9" })).toMatchObject({ ok: false, code: "bad_rating" });
    const a = T({ attempt: "cart" }); expect(a.ok && (a.value.warnings as string[]).join()).toMatch(/alias/);
  });
  it("depth lines up with checkout-map stages", () => {
    expect(tagsOf(T({ depth: "product" }))).toContainEqual(["depth", "product"]);
    expect(tagsOf(T({ depth: "shipform" }))).toContainEqual(["depth", "shipping"]);
  });
  it("keeps product, warns on unknown fields, uses vocab pay codes", () => {
    const r = T({ depth: "cart", product: "https://x.com/p/1", colour: "red", pay_used: "lightning" });
    expect(tagsOf(r)).toContainEqual(["product", "https://x.com/p/1"]);
    expect(tagsOf(r)).toContainEqual(["pay_used", "ln"]);
    expect(r.ok && (r.value.warnings as string[]).join()).toMatch(/colour/);
    const p = parseExperience(sign(422, [["r", D], ["depth", "cart"], ["mystery", "x"]]), known);
    expect(p.ok && p.value.warnings.join()).toMatch(/mystery/);
  });
  it("directory and secondhand notes never count toward aggregates", async () => {
    const D2 = "store.google.com";
    const base = await loadAggregates(env.DB, [D2]); const k0 = base.get(D2)?.keys ?? 0;
    for (const b of ["directory", "secondhand", "directory"]) {
      const res = await SELF.fetch("https://example.com/reviews", { method: "POST", body: JSON.stringify(sign(422, exp().filter((t) => t[0] !== "basis").concat([["basis", b]]))), headers: { "Content-Type": "application/json" } });
      expect(res.status).toBe(201);
      expect((await res.json<{ counts_toward_chart: boolean }>()).counts_toward_chart).toBe(false);
    }
    const after = await loadAggregates(env.DB, [D2]);
    expect(after.get(D2)?.keys ?? 0).toBe(k0);
    expect(T({ depth: "cart", basis: "hearsay" })).toMatchObject({ ok: false, code: "bad_basis" });
  });
});
