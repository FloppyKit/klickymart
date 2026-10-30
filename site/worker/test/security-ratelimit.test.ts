import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils.js";
import { take, takeAll } from "../src/ratelimit";
import { facilitate } from "../src/facilitate";

const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace; };

describe("KM-008: atomic rate limits", () => {
  it("8 parallel takes against limit 1 grant exactly 1; limit 3 grants exactly 3", async () => {
    const k1 = "t:" + bytesToHex(secp.utils.randomSecretKey());
    const r1 = await Promise.all(Array.from({ length: 8 }, () => take(env.DB, { k: k1, limit: 1, ttlS: 60 })));
    expect(r1.filter(Boolean).length).toBe(1);
    const k3 = "t:" + bytesToHex(secp.utils.randomSecretKey());
    const r3 = await Promise.all(Array.from({ length: 10 }, () => take(env.DB, { k: k3, limit: 3, ttlS: 60 })));
    expect(r3.filter(Boolean).length).toBe(3);
    expect(await takeAll(env.DB, [{ k: k1, limit: 1, ttlS: 60 }])).not.toBeNull();
  });
  it("8 parallel facilitate calls for one agent+domain (cap 1/day) sign at most once (audit KM-008 repro)", async () => {
    const SK = bytesToHex(secp.utils.randomSecretKey()); const agent = bytesToHex(secp.schnorr.getPublicKey(secp.utils.randomSecretKey()));
    const d = "race.example"; const store = kv();
    const rs = await Promise.all(Array.from({ length: 8 }, () => facilitate({ DB: env.DB, KV: store, FACILITATOR_SK_HEX: SK, SUBMIT_SALT: "test-salt" }, { domain: d, agent_pubkey: agent, proof: { type: "hash", sha256: "ef".repeat(32) } }, () => true, "203.0.113.9")));
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.status === 429).length).toBe(7);
  });
});
