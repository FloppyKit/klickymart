import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { parseReviewEvent } from "../src/reviews";
import { NOSTR_KIND_ACCEPTANCE } from "../src/nostr-kinds";

const A = "31420:" + "a".repeat(64) + ":store.google.com";
function sign(tags: string[][], content = "Reached checkout, card only.", sk = secp.utils.randomSecretKey(), created_at = Math.floor(Date.now() / 1000)) {
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk));
  const ev = { pubkey, created_at, kind: NOSTR_KIND_ACCEPTANCE, tags, content };
  const id = nostrEventId(ev);
  const sig = bytesToHex(secp.schnorr.sign(hexToBytes(id), sk));
  return { ...ev, id, sig };
}
const good = (extra: string[][] = []) => [["a", A], ["r", "store.google.com"], ["rating", "4", "5"], ["attempt", "checkout"], ["pay", "card"], ...extra];
const post = (ev: unknown, q = "") => SELF.fetch(`https://example.com/reviews${q}`, { method: "POST", body: JSON.stringify(ev), headers: { "Content-Type": "application/json" } });

describe("parseReviewEvent", () => {
  const known = (d: string) => d === "store.google.com";
  it("accepts a valid signed review", () => {
    const r = parseReviewEvent(sign(good()), known);
    expect(r.ok && r.value.rating).toBe(4);
  });
  it("rejects tampered content", () => {
    const ev = sign(good()); ev.content = "changed";
    expect(parseReviewEvent(ev, known)).toMatchObject({ ok: false, code: "bad_signature" });
  });
  it("rejects missing a tag, bad rating, bad attempt, unknown domain, stale time, secrets", () => {
    expect(parseReviewEvent(sign([["rating", "4"], ["attempt", "browse"]]), known)).toMatchObject({ code: "missing_a" });
    expect(parseReviewEvent(sign([["a", A], ["rating", "9", "5"], ["attempt", "browse"]]), known)).toMatchObject({ code: "bad_rating" });
    expect(parseReviewEvent(sign([["a", A], ["rating", "3"], ["attempt", "bought"]]), known)).toMatchObject({ code: "bad_attempt" });
    expect(parseReviewEvent(sign(good()), () => false)).toMatchObject({ code: "unknown_domain" });
    expect(parseReviewEvent(sign(good(), "x", undefined, 1000), known)).toMatchObject({ code: "bad_time" });
    expect(parseReviewEvent({ ...sign(good()), nsec: "nsec1..." }, known)).toMatchObject({ code: "secret_sent" });
  });
  it("records an attached 421 + proof without calling it verified", () => {
    const r = parseReviewEvent(sign(good([["e", "b".repeat(64), "wss://nos.lol", "fulfillment"], ["zap", "c".repeat(64)]])), known);
    expect(r.ok && r.value.proof).toBe("zap");
  });
});

describe("POST /reviews", () => {
  it("dry run validates without storing", async () => {
    const ev = sign(good());
    const r = await post(ev, "?dry_run=1");
    expect(r.status).toBe(200);
    expect((await r.json<{ dry_run: boolean }>()).dry_run).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM reviews WHERE id = ?").bind(ev.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
  it("stores, rate-limits per key+merchant, and shows on /records, /check, merchant page, MCP", async () => {
    const sk = secp.utils.randomSecretKey();
    const ev = sign(good(), "Agent reached the payment screen.", sk);
    const r = await post(ev);
    expect(r.status).toBe(201);
    expect((await post(sign(good(), "again", sk))).status).toBe(429);
    const rec = await (await SELF.fetch("https://example.com/records/store.google.com")).json<{ reviews: { count: number; items: { content: string; verified: string }[] } }>();
    expect(rec.reviews.count).toBeGreaterThanOrEqual(1);
    expect(rec.reviews.items[0]!.verified).toContain("claim");
    const chk = await (await SELF.fetch("https://example.com/check?domain=store.google.com")).json<{ reviews: { count: number } }>();
    expect(chk.reviews.count).toBeGreaterThanOrEqual(1);
    const html = await (await SELF.fetch("https://example.com/merchant/store.google.com", { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("Agent reached the payment screen.");
    const m = await (await SELF.fetch("https://example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_reviews", arguments: { domain: "store.google.com" } } }) })).json<{ result: { structuredContent: { reviews: { count: number } } } }>();
    expect(m.result.structuredContent.reviews.count).toBeGreaterThanOrEqual(1);
    const cols = Object.keys((await env.DB.prepare("SELECT * FROM reviews LIMIT 1").first()) as object);
    expect(cols.some((c) => /ip|agent|ua/i.test(c))).toBe(false);
  });
  it("rejects bad bodies", async () => {
    expect((await SELF.fetch("https://example.com/reviews", { method: "POST", body: "nope" })).status).toBe(400);
    const ev = sign(good()); ev.sig = "0".repeat(128);
    expect((await post(ev)).status).toBe(400);
  });
  it("MCP submit_review dry run", async () => {
    const ev = sign(good());
    const m = await (await SELF.fetch("https://example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_review", arguments: { event: ev, dry_run: true } } }) })).json<{ result: { structuredContent: { ok: boolean; dry_run: boolean } } }>();
    expect(m.result.structuredContent).toMatchObject({ ok: true, dry_run: true });
  });
  it("is documented for agents", async () => {
    const t = await (await SELF.fetch("https://example.com/llms.txt")).text();
    for (const s of ["kind 422", "POST", "/reviews", "fresh Nostr keypair", "never send an nsec", "signed claims"]) expect(t).toContain(s);
    const about = await (await SELF.fetch("https://example.com/about", { headers: { Accept: "text/html" } })).text();
    expect(about).toContain('id="reviews"');
  });
});
