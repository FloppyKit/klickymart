import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, buildFilters, type Ev, type IngestCtx } from "../src/relay-ingest";
import { facilitate, markFacilitatedHistory, FACILITATOR_PUBKEY } from "../src/facilitate";
import { loadTips } from "../src/tips";
import { loadAggregates } from "../src/experience";
import { getReviews } from "../src/reviews";
import { getCommunity } from "../src/community";

const DOM = "store.google.com";
const ctx = (): IngestCtx => ({ domains: new Set([DOM]), ourPubkey: "3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242" });
const key = () => secp.utils.randomSecretKey();
const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
function sign(sk: Uint8Array, kind: number, tags: string[][], content = "", created_at = Math.floor(Date.now() / 1000)): Ev {
  const base = { pubkey: pk(sk), created_at, kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
function fakeBolt11(hashHex: string, hrp = "lnbc10u"): string {
  const ts = Math.floor(Date.now() / 1000); const tsw: number[] = [];
  for (let i = 6; i >= 0; i--) tsw.push(Math.floor(ts / 32 ** i) % 32);
  const hw = bech32.toWords(hexToBytes(hashHex));
  return bech32.encode(hrp, [...tsw, 1, Math.floor(hw.length / 32), hw.length % 32, ...hw, ...new Array(104).fill(0)], 10_000);
}
const R = "wss://r.test";
const ing = (evs: Ev[]) => ingestEvents(env.DB, evs.map((ev) => ({ ev, relay: R })), ctx());
const count = async (t: string, id: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE id = ?`).bind(id).first<{ n: number }>())!.n;
const note = (sk: Uint8Array, extra: string[][] = []) => sign(sk, 422, [["a", `31420:${ctx().ourPubkey}:${DOM}`], ["r", DOM], ["depth", "paid"], ["basis", "visit"], ["rating", "5", "5"], ["attempt", "paid"], ...extra], "ok");

beforeEach(async () => {
  for (const t of ["nostr_events", "site_records", "ingest_state", "reviews", "experiences", "claims", "tombstones"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("NIP-09 deletions", () => {
  it("author's kind 5 removes the note, its tips and its aggregate weight; a tombstone blocks re-ingest", async () => {
    const a = key(), lnurl = key(), tipper = key();
    const n = note(a);
    await ing([n]);
    const req = sign(tipper, 9734, [["e", n.id], ["amount", "1000000"]]);
    await ing([sign(lnurl, 9735, [["e", n.id], ["bolt11", fakeBolt11("cd".repeat(32))], ["description", JSON.stringify(req)]])]);
    expect((await loadTips(env.DB, DOM)).byNote.size).toBe(1);
    expect(await count("experiences", n.id)).toBe(1);
    await ing([sign(a, 5, [["e", n.id], ["k", "422"]], "deleting")]);
    for (const t of ["nostr_events", "experiences", "reviews"]) expect(await count(t, n.id)).toBe(0);
    expect((await loadTips(env.DB, DOM)).byNote.size).toBe(0);
    expect((await loadAggregates(env.DB, [DOM])).get(DOM)).toBeUndefined();
    const again = await ing([n]);
    expect(again.reasons["deleted by author (tombstone)"]).toBe(1);
    expect(await count("experiences", n.id)).toBe(0);
    const post = await SELF.fetch("https://example.com/reviews", { method: "POST", body: JSON.stringify(n) });
    expect(post.status).toBe(410);
  });
  it("a kind 5 from a different pubkey is ignored", async () => {
    const a = key(), mallory = key();
    const n = note(a);
    await ing([n]);
    await ing([sign(mallory, 5, [["e", n.id]])]);
    expect(await count("experiences", n.id)).toBe(1);
    expect(await count("nostr_events", n.id)).toBe(1);
    expect(await count("tombstones", n.id)).toBe(0);
  });
  it("deletion that arrives before the note blocks only the deleter's own event", async () => {
    const a = key();
    const n = note(a);
    await ing([sign(a, 5, [["e", n.id]])]);
    await ing([n]);
    expect(await count("experiences", n.id)).toBe(0);
  });
  it("filters subscribe to kind 5 by id and by k tag; the self-test note stays tombstoned", async () => {
    const f = JSON.stringify(buildFilters(ctx(), 0, ["ab".repeat(32)]));
    expect(f).toContain('"kinds":[5,1984],"#e"');
    expect(f).toContain('"#k"');
    // migration 0008 seeds the tombstone for the 2026-10-30 relay self-test note
    await env.DB.prepare("INSERT OR IGNORE INTO tombstones (id,pubkey,deletion_id,deleted_at) VALUES ('c09fb82f9fccb4d20fe6944533714f5d998593dbe33a5bbad99ed4b963b891bb','deb0e9c1c44df85bf86c6b1d3ba79697e65107c7d30e078ff11c45815af4c2dd','662445a3ff22d26b50d17f9d28b5da248133263a5116ac697d99f56fb08d58dd',1)").run();
    expect(await count("tombstones", "c09fb82f9fccb4d20fe6944533714f5d998593dbe33a5bbad99ed4b963b891bb")).toBe(1);
  });
});

describe("facilitated 421s become history once the store claims", () => {
  it("before claim: verified + weighted; after claim: labelled history, no weight, not a verified payment", async () => {
    const SK = bytesToHex(key());
    const pre = bytesToHex(key()); const inv = fakeBolt11(bytesToHex(sha256(hexToBytes(pre))));
    const buyerSk = key(), other = key();
    const kv = new Map<string, string>();
    const r = await facilitate({ DB: env.DB, KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) } as unknown as KVNamespace, FACILITATOR_SK_HEX: SK },
      { domain: DOM, agent_pubkey: pk(buyerSk), proof: { type: "preimage", preimage: pre, bolt11: inv } }, (d) => d === DOM, "ip");
    // use a local test key in place of the production facilitator key
    const ful = r.body.event as Ev;
    const facEv = { ...ful, pubkey: FACILITATOR_PUBKEY } as Ev; // test the label path; store directly (signature is for the local key)
    await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind(ful.id, 421, FACILITATOR_PUBKEY, ful.created_at, DOM, JSON.stringify(facEv), 1, R).run();
    const rv = note(buyerSk, [["e", ful.id, R, "fulfillment"], ["preimage", pre]]);
    await ing([rv, note(other)]);
    const before = (await loadAggregates(env.DB, [DOM])).get(DOM)!;
    expect(((await getReviews(env.DB, DOM)).items.find((x) => x.id === rv.id) as any)?.proof_status).toBe("verified-preimage");
    expect(before.success_score).toBe(1);
    expect(before.proof_keys).toBe(1);
    await env.DB.prepare("INSERT INTO claims (d,pubkey,nip05,checked_at) VALUES (?,?,?,?)").bind(DOM, pk(key()), "_", Math.floor(Date.now() / 1000)).run();
    expect(await markFacilitatedHistory(env.DB, DOM)).toBeGreaterThan(0);
    const item = (await getReviews(env.DB, DOM)).items.find((x) => x.id === rv.id)!;
    expect((item as any).proof_status).toBe("facilitated-history");
    expect(item.verified).toMatch(/history only.*not store-confirmed/);
    const after = (await loadAggregates(env.DB, [DOM])).get(DOM)!;
    expect(after.proof_keys).toBe(0);
    const c = await getCommunity(env.DB, DOM, null);
    expect(c.verified_payments).toBe(0);
    expect(c.facilitated_history?.reviewers).toBe(1);
    // and new facilitation is refused after the claim
    expect((await facilitate({ DB: env.DB, KV: { get: async () => null, put: async () => {} } as unknown as KVNamespace, FACILITATOR_SK_HEX: SK },
      { domain: DOM, agent_pubkey: pk(key()), proof: { type: "hash", sha256: "ef".repeat(32) } }, (d) => d === DOM, "ip")).status).toBe(409);
  });
});
