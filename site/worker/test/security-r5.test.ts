import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils.js";
import { take, takeAll } from "../src/ratelimit";
import { submitStore, ipHash, ipNetwork, SUBMIT_LIMITS } from "../src/submissions";
import { facilitate } from "../src/facilitate";

const rnd = () => bytesToHex(secp.utils.randomSecretKey());
const ctx = (signed: { id: string; pubkey: string }, ip: string, domain: string) => ({ db: env.DB, indexed: new Set<string>(), salt: "test-salt", ip, via: "nostr" as const, origin: "https://klickymart.com",
  signed: { ...signed, created_at: Math.floor(Date.now() / 1000), domain, category: null, note: "", evidence_url: null } });
beforeEach(async () => { await env.DB.prepare("DELETE FROM rate_limits").run(); });

describe("R5 rate-limit fixes", () => {
  it("R5-001: replaying a victim's stored signed 1423 from other networks does not burn the victim's quota", async () => {
    const victim = rnd(); const first = { id: rnd(), pubkey: victim };
    expect((await submitStore({}, ctx(first, "198.51.100.1", `r5-${rnd().slice(0, 8)}.com`))).status).toBeLessThan(300);
    for (let i = 0; i < 12; i++) expect((await submitStore({}, ctx(first, `203.0.113.${i + 10}`, "ignored.com"))).status).not.toBe(429);
    const n = await env.DB.prepare("SELECT n FROM rate_limits WHERE k = ?").bind(`sub:pk:${victim}:${new Date().toISOString().slice(0, 10)}`).first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect((await submitStore({}, ctx({ id: rnd(), pubkey: victim }, "198.51.100.1", `r5-${rnd().slice(0, 8)}.com`))).status).toBeLessThan(300);
  });
  it("R5-001: 8 concurrent copies of one unstored signed 1423 take the key quota once", async () => {
    const victim = rnd(); const ev = { id: rnd(), pubkey: victim }; const d = `r5c-${rnd().slice(0, 8)}.com`;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => submitStore({}, ctx(ev, `203.0.113.${i + 50}`, d))));
    expect(rs.every((r) => r.status !== 429)).toBe(true);
    expect((await env.DB.prepare("SELECT n FROM rate_limits WHERE k = ?").bind(`sub:pk:${victim}:${new Date().toISOString().slice(0, 10)}`).first<{ n: number }>())?.n).toBe(1);
  });
  it("R5-002/R5-003: takeAll gives back earlier takes when a later limit refuses", async () => {
    const g = { k: "g:" + rnd(), limit: 5, ttlS: 60 }; const narrow = { k: "n:" + rnd(), limit: 1, ttlS: 60 };
    expect(await take(env.DB, narrow)).toBe(true);
    for (let i = 0; i < 10; i++) expect((await takeAll(env.DB, [g, narrow]))?.k).toBe(narrow.k);
    expect((await env.DB.prepare("SELECT n FROM rate_limits WHERE k = ?").bind(g.k).first<{ n: number }>())?.n ?? 0).toBe(0);
  });
  it("R5-002: one ip over its facilitate cap does not consume the global cap", async () => {
    const SK = rnd(); const e = { DB: env.DB, KV: {} as KVNamespace, FACILITATOR_SK_HEX: SK, SUBMIT_SALT: "test-salt" };
    for (let i = 0; i < 40; i++) await facilitate(e, { domain: "ip.example", agent_pubkey: bytesToHex(secp.schnorr.getPublicKey(secp.utils.randomSecretKey())), proof: { type: "hash", sha256: "ef".repeat(32) } }, () => true, "203.0.113.77");
    const day = new Date().toISOString().slice(0, 10);
    const ip = await env.DB.prepare("SELECT n FROM rate_limits WHERE k LIKE 'fac:ip:%'").first<{ n: number }>();
    const gl = await env.DB.prepare("SELECT n FROM rate_limits WHERE k = ?").bind(`fac:g:${day}`).first<{ n: number }>();
    expect(gl?.n).toBe(ip?.n);
  });
  it("R5-004: ipHash buckets IPv6 by /64 and IPv4 by address", () => {
    expect(ipNetwork("2001:db8:1:2::1")).toBe(ipNetwork("2001:0db8:0001:0002:ffff:1:2:3"));
    expect(ipNetwork("2001:db8:1:3::1")).not.toBe(ipNetwork("2001:db8:1:2::1"));
    expect(ipNetwork("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(ipHash("2001:db8:1:2::a", "s", 0)).toBe(ipHash("2001:db8:1:2::b", "s", 0));
    expect(ipHash("203.0.113.5", "s", 0)).not.toBe(ipHash("203.0.113.6", "s", 0));
  });
  it("R5-005: facilitate fails closed without the SUBMIT_SALT secret", async () => {
    const r = await facilitate({ DB: env.DB, KV: {} as KVNamespace, FACILITATOR_SK_HEX: rnd() }, { domain: "x.example", agent_pubkey: bytesToHex(secp.schnorr.getPublicKey(secp.utils.randomSecretKey())), proof: { type: "hash", sha256: "ef".repeat(32) } }, () => true, "203.0.113.1");
    expect(r.status).toBe(503);
  });
  it("R5-006: a limiter failure is a 503, not a silent skip", async () => {
    const broken = new Proxy(env.DB, { get(t, p) { if (p === "prepare") return (sql: string) => { if (sql.includes("rate_limits")) throw new Error("boom"); return t.prepare(sql); }; const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; } });
    const r = await submitStore({}, { ...ctx({ id: rnd(), pubkey: rnd() }, "203.0.113.200", `r5e-${rnd().slice(0, 8)}.com`), db: broken as D1Database });
    expect(r.status).toBe(503);
    expect(SUBMIT_LIMITS.perDay).toBeGreaterThan(0);
  });
});
