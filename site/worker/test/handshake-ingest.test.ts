import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, type Ev, type IngestCtx } from "../src/relay-ingest";
import { getCommunity } from "../src/community";
import { checkThreads } from "../src/handshake";
import { getHandshakeMarks, handshakeMarksEnabled } from "../src/handshake-marks";

const DOM = "store.google.com";
const R1 = "wss://relay.one.test";
// Synthetic keys only, generated per run.
const key = () => secp.utils.randomSecretKey();
function sign(sk: Uint8Array, kind: number, tags: string[][], content = ""): Ev {
  const base = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
function loop(selfDeal = false) {
  const a = key(), b = selfDeal ? a : key();
  const n = sign(a, 420, [["r", DOM], ["amount", "1000"]], "need");
  const f = sign(b, 421, [["r", DOM], ["e", n.id, "", "need"], ["p", n.pubkey], ["proof", "order", "X1"]], "done");
  const x = sign(a, 422, [["r", DOM], ["e", f.id, "", "fulfillment"], ["e", n.id, "", "need"], ["p", f.pubkey], ["amount", "1000"], ["rating", "5", "5"], ["attempt", "paid"]], "thanks");
  return { n, f, x };
}
const ctx = (extra: Partial<IngestCtx> = {}): IngestCtx => ({ domains: new Set([DOM]), ourPubkey: null, ...extra });
const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS c FROM handshake_marks").first<{ c: number }>())!.c;

beforeEach(async () => {
  for (const t of ["nostr_events", "reviews", "handshake_marks", "proof_uses"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("KM_HANDSHAKE_MARKS kill switch", () => {
  it("parses the flag (default on)", () => {
    expect(handshakeMarksEnabled({})).toBe(true);
    expect(handshakeMarksEnabled({ KM_HANDSHAKE_MARKS: "1" })).toBe(true);
    for (const v of ["0", "false", "off", " OFF "]) expect(handshakeMarksEnabled({ KM_HANDSHAKE_MARKS: v })).toBe(false);
  });
  it("on: stores marks for 420/421/422 at ingest (self-fulfilment marked)", async () => {
    const { n, f, x } = loop(true);
    let calls = 0; const spy: typeof checkThreads = (e, o) => { calls++; return checkThreads(e, o); };
    await ingestEvents(env.DB, [n, f, x].map((ev) => ({ ev, relay: R1 })), ctx({ handshakeMarks: true, handshakeChecker: spy }));
    expect(calls).toBe(1);
    expect(await count()).toBe(3);
    expect((await getHandshakeMarks(env.DB, f.id))!.marks).toContain("self_fulfillment");
  });
  it("on: refs from an earlier batch are looked up in storage", async () => {
    const { n, f, x } = loop();
    await ingestEvents(env.DB, [{ ev: n, relay: R1 }], ctx());
    await ingestEvents(env.DB, [{ ev: f, relay: R1 }, { ev: x, relay: R1 }], ctx());
    expect((await getHandshakeMarks(env.DB, f.id))!.marks).not.toContain("orphan");
    expect((await getHandshakeMarks(env.DB, x.id))!.marks).toEqual(["accepted_unpaid"]);
  });
  it("off: validator called zero times and zero marks stored", async () => {
    const { n, f, x } = loop(true);
    let calls = 0; const spy: typeof checkThreads = (e, o) => { calls++; return checkThreads(e, o); };
    const r = await ingestEvents(env.DB, [n, f, x].map((ev) => ({ ev, relay: R1 })), ctx({ handshakeMarks: false, handshakeChecker: spy }));
    expect(calls).toBe(0);
    expect(await count()).toBe(0);
    expect(r.accepted).toBe(3); // ingest itself unchanged
  });
  it("marks never change community aggregates / ordering inputs (on vs off identical)", async () => {
    const loops = [loop(), loop(true), loop()];
    const evs = loops.flatMap(({ n, f, x }) => [n, f, x]).map((ev) => ({ ev, relay: R1 }));
    await ingestEvents(env.DB, evs, ctx({ handshakeMarks: false }));
    const off = await getCommunity(env.DB, DOM, null);
    const offReviews = (await env.DB.prepare("SELECT id FROM reviews ORDER BY rowid").all()).results;
    for (const t of ["nostr_events", "reviews", "handshake_marks", "proof_uses"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await ingestEvents(env.DB, evs, ctx({ handshakeMarks: true }));
    expect(await count()).toBe(9);
    expect(await getCommunity(env.DB, DOM, null)).toEqual(off);
    expect((await env.DB.prepare("SELECT id FROM reviews ORDER BY rowid").all()).results).toEqual(offReviews);
  });
  it("no ranking/visibility code reads handshake marks", () => {
    const files = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
    const readers = Object.entries(files).filter(([p, s]) => !/handshake(-marks)?\.ts$/.test(p) && /handshake_marks|getHandshakeMarks|from "\.\/handshake"/.test(s)).map(([p]) => p);
    expect(readers).toEqual([]);
  });
});
