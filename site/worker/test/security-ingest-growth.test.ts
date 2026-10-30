import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, validateRelayEvent, type Ev, type IngestCtx } from "../src/relay-ingest";

const DOM = "dell.com";
const ctx = (): IngestCtx => ({ domains: new Set([DOM]), ourPubkey: null });
const key = () => secp.utils.randomSecretKey();
function sign(sk: Uint8Array, kind: number, tags: string[][], content = ""): Ev {
  const base = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
beforeEach(async () => { for (const t of ["nostr_events", "site_records", "experiences", "reviews"]) { try { await env.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* */ } } });

describe("KM-009: relay ingest growth", () => {
  it("31420 records for domains outside the index are rejected", () => {
    expect(validateRelayEvent(sign(key(), 31420, [["d", "not-indexed.example"]], "{}"), ctx()).ok).toBe(false);
    expect(validateRelayEvent(sign(key(), 31420, [["d", DOM]], "{}"), ctx()).ok).toBe(true);
  });
  it("one key cannot store unlimited zap receipts: receipts must target a held note", async () => {
    const k = key();
    const junk = Array.from({ length: 30 }, () => sign(k, 9735, [["e", bytesToHex(key())]]));
    const r = await ingestEvents(env.DB, junk.map((ev) => ({ ev, relay: "wss://r" })), ctx());
    expect(r.accepted).toBe(0);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM nostr_events WHERE kind = 9735").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
