import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils.js";
import { computeTrustTiers } from "../src/submissions";
import { facilitate, markFacilitatedHistory, FACILITATOR_PUBKEY } from "../src/facilitate";

const key = () => secp.utils.randomSecretKey();
const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace; };
const tier = async (d: string) => (await computeTrustTiers(env.DB, [d], () => null, Date.now(), { noCache: true })).get(d)!;
async function siteRecord(pubkey: string, d: string) {
  await env.DB.prepare("INSERT INTO site_records (pubkey,d,id,created_at,raw_json,relays) VALUES (?,?,?,?,?,?)").bind(pubkey, d, bytesToHex(key()), 1, "{}", "wss://r").run();
}
async function nip05(pubkey: string, nip05v: string, domain: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO nip05_checks (pubkey,nip05,domain,status,checked_at) VALUES (?,?,?,?,?)").bind(pubkey, nip05v, domain, "verified", 1).run();
}

beforeEach(async () => {
  for (const t of ["nostr_events", "site_records", "claims", "store_claims", "nip05_checks", "reviews", "experiences"]) { try { await env.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* */ } }
});

describe("KM-005: NIP-05 store claim", () => {
  it("a user handle (alice@dell.com) plus a self-signed 31420 does not verify the store", async () => {
    const a = pk(key()); await nip05(a, "alice@dell.com", "dell.com"); await siteRecord(a, "dell.com");
    expect((await tier("dell.com")).trust_proofs).not.toContain("store claim: NIP-05");
  });
  it("the domain identity _@dell.com does verify; _@primal.net (open provider) never does", async () => {
    const a = pk(key()); await nip05(a, "_@dell.com", "dell.com"); await siteRecord(a, "dell.com");
    expect((await tier("dell.com")).trust_proofs).toContain("store claim: NIP-05");
    const b = pk(key()); await nip05(b, "_@strike.me", "strike.me"); await siteRecord(b, "strike.me");
    expect((await tier("strike.me")).trust_proofs).not.toContain("store claim: NIP-05");
  });
});

describe("KIMI-004: DNS claims stop facilitation and demote facilitated proofs", () => {
  it("an active store_claims row makes facilitate return 409 and markFacilitatedHistory run", async () => {
    const d = "dns-claimed.example";
    await env.DB.prepare("INSERT INTO store_claims (domain,pubkey,method,status,txt,event_id,claimed_at,checked_at) VALUES (?,?,'dns','active','t',?,1,1)").bind(d, pk(key()), bytesToHex(key())).run();
    const r = await facilitate({ DB: env.DB, KV: kv(), FACILITATOR_SK_HEX: bytesToHex(key()), SUBMIT_SALT: "test-salt" }, { domain: d, agent_pubkey: pk(key()), proof: { type: "hash", sha256: "ef".repeat(32) } }, () => true, "ip");
    expect(r.status).toBe(409);
    const ful = bytesToHex(key());
    await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind(ful, 421, FACILITATOR_PUBKEY, 1, d, "{}", 1, "r").run();
    await env.DB.prepare("INSERT INTO reviews (id,d,pubkey,created_at,rating,rating_max,attempt,content,raw_json,received_day,fulfillment,proof_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(bytesToHex(key()), d, pk(key()), 1, 5, 5, "paid", "x", "{}", "2026-10-30", ful, "facilitated-unverified").run();
    const n = await markFacilitatedHistory(env.DB, d);
    const row = await env.DB.prepare("SELECT proof_status FROM reviews WHERE d = ?").bind(d).first<{ proof_status: string }>();
    expect(n).toBeGreaterThan(0); expect(row?.proof_status).toBe("facilitated-history");
    // revoked claims no longer block
    await env.DB.prepare("UPDATE store_claims SET status = 'revoked' WHERE domain = ?").bind(d).run();
    const r2 = await facilitate({ DB: env.DB, KV: kv(), FACILITATOR_SK_HEX: bytesToHex(key()), SUBMIT_SALT: "test-salt" }, { domain: d, agent_pubkey: pk(key()), proof: { type: "hash", sha256: "ef".repeat(32) } }, () => true, "ip");
    expect(r2.status).toBe(200);
  });
});
