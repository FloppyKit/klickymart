import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleDnsClaim } from "../src/dns-claim";
import { ipHash, submitStore } from "../src/submissions";

const PK = "ab".repeat(32);
async function activeClaim(domain: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO store_claims (domain,pubkey,method,status,txt,event_id,claimed_at,checked_at) VALUES (?,?,?,?,?,?,?,?)").bind(domain, PK, "dns", "active", null, "cd".repeat(32), 1, 1).run();
}
describe("KIMI-010: DNS re-check throttle is reached and fails closed", () => {
  it("second re-check of the same domain within 10 min is 429 and does no lookup", async () => {
    await activeClaim("throttle-test.com"); let lookups = 0; const lookup = async () => { lookups++; return [] as string[]; };
    const now = Date.UTC(2026, 9, 30, 12);
    const a = await handleDnsClaim(env.DB, { domain: "throttle-test.com" }, { lookup, now, dryRun: true });
    const b = await handleDnsClaim(env.DB, { domain: "throttle-test.com" }, { lookup, now: now + 1000, dryRun: true });
    expect(a.status).toBe(200); expect(b.status).toBe(429); expect(lookups).toBe(1);
  });
  it("a throttle storage error refuses (429) without any lookup", async () => {
    await activeClaim("broken-test.com"); let lookups = 0; const lookup = async () => { lookups++; return [] as string[]; };
    const db = new Proxy(env.DB, { get(t, k) { if (k === "prepare") return (q: string) => { if (/rate_limits/.test(q)) throw new Error("boom"); return t.prepare(q); }; const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v; } }) as D1Database;
    const r = await handleDnsClaim(db, { domain: "broken-test.com" }, { lookup, dryRun: true });
    expect(r.status).toBe(429); expect(lookups).toBe(0);
  });
});
describe("R5-005: no per-isolate salt fallback", () => {
  it("unsalted ipHash is one shared bucket with nothing IP-derived; submissions refuse without SUBMIT_SALT", async () => {
    expect(ipHash("1.2.3.4", "")).toBe("unsalted"); expect(ipHash("5.6.7.8", "")).toBe("unsalted");
    expect(ipHash("1.2.3.4", "s")).not.toBe(ipHash("5.6.7.8", "s"));
    const r = await submitStore({ domain: "example.org" } as never, { db: env.DB, indexed: new Set(), salt: "", ip: "1.2.3.4", via: "post", dryRun: true, origin: "https://klickymart.com" } as never);
    expect(r.status).toBe(503);
  });
});

import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, INGEST_LIMITS, MAX_UNSEEN_TOMBSTONES } from "../src/relay-ingest";
const signK = (sk: Uint8Array, kind: number, tags: string[][], created_at = Math.floor(Date.now() / 1000)) => {
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at, kind, tags, content: "" }; const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
};
const rid = () => bytesToHex(secp.utils.randomSecretKey());
describe("K-DEL / KM-009: kind 5 respects the per-key cap and bounds tombstones", () => {
  it("a key's deletions stop at perPubkeyPerDay; one deletion writes at most MAX_UNSEEN_TOMBSTONES for unseen ids", async () => {
    const sk = secp.utils.randomSecretKey(); const pk = bytesToHex(secp.schnorr.getPublicKey(sk));
    const big = signK(sk, 5, Array.from({ length: 60 }, () => ["e", rid()]));
    await ingestEvents(env.DB, [{ ev: big, relay: "wss://r.test" }], { domains: new Set(), ourPubkey: null });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM tombstones WHERE deletion_id = ?").bind(big.id).first<{ n: number }>())!.n).toBe(MAX_UNSEEN_TOMBSTONES);
    const many = Array.from({ length: INGEST_LIMITS.perPubkeyPerDay + 4 }, (_, i) => signK(sk, 5, [["e", rid()]], Math.floor(Date.now() / 1000) - i));
    const r = await ingestEvents(env.DB, many.map((ev) => ({ ev, relay: "wss://r.test" })), { domains: new Set(), ourPubkey: null });
    expect(r.reasons["rate-limited pubkey"]).toBe(5); // 1 earlier + 199 now = 200
    expect((await env.DB.prepare("SELECT COUNT(DISTINCT deletion_id) n FROM tombstones WHERE pubkey = ?").bind(pk).first<{ n: number }>())!.n).toBe(INGEST_LIMITS.perPubkeyPerDay);
  });
});

import { SELF } from "cloudflare:test";
import { checkFacilitationProof, FACILITATOR_PUBKEY } from "../src/facilitate";
describe("facilitation: bare hashes refused; revokeFacilitated has runtime + admin callers", () => {
  it("/facilitate proof check refuses an attacker-chosen bare hash", () => {
    expect(checkFacilitationProof({ type: "hash", sha256: "ef".repeat(32) })).toMatchObject({ ok: false, code: "bad_proof" });
  });
  it("revokeFacilitated (the call ingest now makes for re-seen facilitator 421s) records the revocation; ingest wiring is by code review since tests cannot sign with the production facilitator key", async () => {
    const id = rid(); const fac = { id, pubkey: FACILITATOR_PUBKEY, created_at: 1, kind: 421, tags: [["r", "x.com"]], content: "", sig: "00".repeat(64) };
    await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind(id, 421, FACILITATOR_PUBKEY, 1, "x.com", JSON.stringify(fac), 1, "t").run();
    const { revokeFacilitated } = await import("../src/facilitate");
    expect((await revokeFacilitated(env.DB, { ids: [id] })).revoked).toBe(1);
    expect((await env.DB.prepare("SELECT reason FROM revoked_events WHERE id = ?").bind(id).first<{ reason: string }>())?.reason).toBe("facilitated-before-pause");
  });
  it("admin path: 404 without INGEST_TOKEN", async () => {
    expect((await SELF.fetch("https://example.com/_admin/revoke-facilitated", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
