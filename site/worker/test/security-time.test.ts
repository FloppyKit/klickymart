import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, validateRelayEvent, type Ev, type IngestCtx } from "../src/relay-ingest";
import { computeTrustTiers } from "../src/submissions";

const DOM = "dell.com";
const ctx = (): IngestCtx => ({ domains: new Set([DOM]), ourPubkey: null });
const key = () => secp.utils.randomSecretKey();
function sign(sk: Uint8Array, kind: number, tags: string[][], content: string, created_at: number): Ev {
  const base = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at, kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const note = (sk: Uint8Array, t: number, i: number) => sign(sk, 422, [["r", DOM], ["depth", "paid"], ["basis", "visit"], ["rating", "5", "5"], ["attempt", "paid"]], `bought a laptop ${i}`, t);

beforeEach(async () => {
  for (const t of ["nostr_events", "site_records", "reviews", "experiences", "note_flags"]) { try { await env.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* */ } }
});

describe("KM-007: backdated / future timestamps", () => {
  it("relay notes older than 60 days or > 10 min in the future are rejected", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(validateRelayEvent(note(key(), now - 61 * 86400, 1), ctx()).ok).toBe(false);
    expect(validateRelayEvent(note(key(), now - 365 * 86400 * 5, 2), ctx()).ok).toBe(false);
    expect(validateRelayEvent(note(key(), now + 3600, 3), ctx()).ok).toBe(false);
    expect(validateRelayEvent(note(key(), now - 40 * 86400, 4), ctx()).ok).toBe(true);
  });
  it("fresh keys with notes backdated 40-50 days do not count as 'real' keys, so the store is not 'seen'", async () => {
    const now = Math.floor(Date.now() / 1000);
    const evs = [0, 1, 2, 3].map((i) => note(key(), now - (40 + i * 3) * 86400, i));
    await ingestEvents(env.DB, evs.map((ev) => ({ ev, relay: "wss://r.test" })), ctx());
    const t = (await computeTrustTiers(env.DB, [DOM], () => null, Date.now(), { noCache: true })).get(DOM)!;
    expect(t.seen?.real_keys ?? 0).toBe(0);
    expect(t.trust_tier).not.toBe("seen");
  });
});
