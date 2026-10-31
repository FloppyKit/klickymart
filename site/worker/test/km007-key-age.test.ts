import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { loadAggregates } from "../src/experience";
import { countsForRank, keyFirstSeen, MIN_RANK_KEY_AGE_S } from "../src/key-age";
import { loadFlagContext } from "../src/flags";
import { ingestEvents } from "../src/relay-ingest";

// KM-007 repro (audit mac/repro-chart.log): two brand-new keys posting 422 depth=paid lifted store.google.com to rank 1.
const D = "store.google.com";
function sign(kind: number, tags: string[][], sk = secp.utils.randomSecretKey(), created_at = Math.floor(Date.now() / 1000), content = "paid") {
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at, kind, tags, content }; const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const paid = () => [["r", D], ["t", "klickymart"], ["basis", "visit"], ["depth", "paid"], ["guest", "yes"], ["pay_used", "lightning"], ["region", "660"]];
const post = (ev: unknown) => SELF.fetch("https://example.com/reviews", { method: "POST", body: JSON.stringify(ev), headers: { "Content-Type": "application/json" } });
const rankOf = async () => { const j = await (await SELF.fetch("https://example.com/chart.json?limit=500")).json<{ items: { d: string; rank: number; score: number; score_source: string }[] }>(); return j.items.find((x) => x.d === D); };

describe("KM-007: fresh keys can't take the chart; key age is ingest time", () => {
  it("two brand-new keys (even with notes backdated 50 days) don't move the store", async () => {
    const before = await rankOf();
    const yearAgo = Math.floor(Date.now() / 1000) - 50 * 86400; // inside RELAY_NOTE_MAX_AGE_S
    // key 1: backdated kind 0 + backdated 422 from a relay; key 2: posted directly now
    const k1 = secp.utils.randomSecretKey();
    const r = await ingestEvents(env.DB, [sign(0, [], k1, yearAgo, "{}"), sign(422, paid(), k1, yearAgo + 60)].map((ev) => ({ ev, relay: "wss://r.test" })), { domains: new Set([D]), ourPubkey: null });
    expect(r.accepted).toBe(2);
    expect((await post(sign(422, paid()))).status).toBe(201);
    const after = await rankOf();
    expect(after?.score_source).toBe(before?.score_source ?? "crawl"); expect(after?.score).toBe(before?.score); expect(after?.rank).toBe(before?.rank);
    const a = (await loadAggregates(env.DB, [D])).get(D); expect(a).toBeUndefined();
    // the same notes count once the keys have been known for 7+ days by ingest time
    await env.DB.batch(["UPDATE experiences SET received_day = '2026-01-01'", "UPDATE nostr_events SET first_seen = 1"].map((q) => env.DB.prepare(q)));
    expect((await loadAggregates(env.DB, [D])).get(D)?.keys).toBe(2);
  });
  it("first-seen ignores created_at; flags see backdated keys as new; no proof skips the gate (K10-001)", async () => {
    const sk = secp.utils.randomSecretKey(); const pk = bytesToHex(secp.schnorr.getPublicKey(sk)); const nowS = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind("ab".repeat(32), 0, pk, 1000, null, "{}", nowS, "t").run();
    const seen = await keyFirstSeen(env.DB); expect(seen.get(pk)).toBe(nowS);
    expect(countsForRank(pk, null, seen, nowS)).toBe(false); expect(countsForRank(pk, null, seen, nowS + MIN_RANK_KEY_AGE_S)).toBe(true);
    expect(countsForRank(pk, "verified-preimage", seen, nowS)).toBe(false); expect(countsForRank(pk, "verified-zap", seen, nowS)).toBe(false); expect(countsForRank("ff".repeat(32), null, seen, nowS)).toBe(false);
    expect((await loadFlagContext(env.DB, [])).firstSeen.get(pk)).toBe(nowS);
  });
});
