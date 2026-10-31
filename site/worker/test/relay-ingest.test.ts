import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { nostrEventId } from "../src/nostr-verify";
import { buildFilters, catchUp, checkProof, ingestEvents, INGEST_LIMITS, type Connect, type Ev, type IngestCtx } from "../src/relay-ingest";
import { getCommunity } from "../src/community";
import { decodeBolt11, encodeBolt11ForTest } from "../src/bolt11";

const DOM = "store.google.com";
const OUR = "3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242";
const ctx = (): IngestCtx => ({ domains: new Set([DOM, "microsoft.com"]), ourPubkey: OUR });
const R1 = "wss://relay.one.test", R2 = "wss://relay.two.test";

function key() { return secp.utils.randomSecretKey(); }
function sign(sk: Uint8Array, kind: number, tags: string[][], content = "", created_at = Math.floor(Date.now() / 1000)): Ev {
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk));
  const base = { pubkey, created_at, kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const aTag = (d = DOM) => ["a", `31420:${OUR}:${d}`];
const review = (sk: Uint8Array, extra: string[][] = [], content = "ok", pay = "lightning", attempt = "paid") =>
  sign(sk, 422, [aTag(), ["r", DOM], ["rating", "4", "5"], ["attempt", attempt], ["pay", pay], ...extra], content);

/** Build a BOLT11 string with a chosen payment hash (zero signature; we only read amount + hash). */
function fakeBolt11(hashHex: string, hrp = "lnbc10u"): string {
  const ts = Math.floor(Date.now() / 1000); const tsw: number[] = [];
  for (let i = 6; i >= 0; i--) tsw.push(Math.floor(ts / 32 ** i) % 32);
  const hw = bech32.toWords(hexToBytes(hashHex));
  const words = [...tsw, 1, Math.floor(hw.length / 32), hw.length % 32, ...hw, ...new Array(104).fill(0)];
  return bech32.encode(hrp, words, 10_000);
}

beforeEach(async () => {
  for (const t of ["nostr_events", "site_records", "ingest_state", "reviews", "claims", "proof_uses"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("relay ingest: validation", () => {
  it("accepts a valid third-party 31420 and keeps it as another publisher's record", async () => {
    const sk = key();
    const r = await ingestEvents(env.DB, [{ ev: sign(sk, 31420, [["d", DOM]], JSON.stringify({ d: DOM, status: "crawled", pay: ["ln"] })), relay: R1 }], ctx());
    expect(r.accepted).toBe(1);
    const c = await getCommunity(env.DB, DOM, OUR);
    expect(c.other_publishers).toHaveLength(1);
    expect(c.other_publishers[0]!.pay).toEqual(["ln"]);
  });
  it("rejects a bad signature and a wrong a-tag", async () => {
    const sk = key();
    const bad = review(sk); bad.sig = "00".repeat(64);
    const wrongA = sign(sk, 422, [["a", `31420:${OUR}:not-indexed.test`], ["rating", "3"], ["attempt", "browse"]], "x");
    const malformedA = sign(sk, 422, [["a", "31420:nothex:store.google.com"], ["rating", "3"], ["attempt", "browse"]], "x");
    const r = await ingestEvents(env.DB, [{ ev: bad, relay: R1 }, { ev: wrongA, relay: R1 }, { ev: malformedA, relay: R1 }], ctx());
    expect(r.accepted).toBe(0);
    expect(r.rejected).toBe(3);
  });
  it("honors replaceable semantics for 31420 (latest per pubkey+d), in any arrival order", async () => {
    const sk = key(); const now = Math.floor(Date.now() / 1000);
    const older = sign(sk, 31420, [["d", DOM]], JSON.stringify({ status: "error" }), now - 100);
    const newer = sign(sk, 31420, [["d", DOM]], JSON.stringify({ status: "crawled" }), now - 10);
    await ingestEvents(env.DB, [{ ev: newer, relay: R1 }], ctx());
    await ingestEvents(env.DB, [{ ev: older, relay: R2 }], ctx());
    const row = await env.DB.prepare("SELECT id FROM site_records WHERE pubkey = ? AND d = ?").bind(newer.pubkey, DOM).first<{ id: string }>();
    expect(row?.id).toBe(newer.id);
  });
  it("dedupes by id and records every relay it was seen on", async () => {
    const ev = review(key());
    await ingestEvents(env.DB, [{ ev, relay: R1 }], ctx());
    const r2 = await ingestEvents(env.DB, [{ ev, relay: R2 }], ctx());
    expect(r2.duplicate).toBe(1);
    const row = await env.DB.prepare("SELECT relays FROM nostr_events WHERE id = ?").bind(ev.id).first<{ relays: string }>();
    expect(row?.relays.split(",").sort()).toEqual([R1, R2]);
    const rv = await env.DB.prepare("SELECT source, relays FROM reviews WHERE id = ?").bind(ev.id).first<{ source: string; relays: string }>();
    expect(rv?.source).toBe("relay");
  });
});

describe("community view", () => {
  it("a wash attempt from one pubkey counts as one agent and is not corroborated", async () => {
    const sk = key();
    const evs = Array.from({ length: 6 }, (_, i) => ({ ev: review(sk, [], `wash ${i}`), relay: R1 }));
    await ingestEvents(env.DB, evs, ctx());
    const c = await getCommunity(env.DB, DOM, OUR);
    expect(c.reviewers).toBe(1);
    const ln = c.pay_reports.find((p) => p.pay === "lightning")!;
    expect(ln.agents).toBe(1);
    expect(ln.corroborated).toBe(false);
    expect(ln.summary).toContain("not corroborated");
  });
  it("two keys corroborate; summary reads like 'Lightning worked (2 agents, 0 verified)'", async () => {
    await ingestEvents(env.DB, [{ ev: review(key()), relay: R1 }, { ev: review(key()), relay: R2 }], ctx());
    const c = await getCommunity(env.DB, DOM, OUR);
    expect(c.pay_reports[0]!.summary).toMatch(/^agents report: lightning worked \(2 agents, 0 verified\)$/i);
  });
  it("per-pubkey rate limit caps a flood", async () => {
    const sk = key();
    const evs = Array.from({ length: INGEST_LIMITS.perPubkeyPerDay + 3 }, (_, i) => ({ ev: sign(sk, 420, [["r", DOM]], `need ${i}`), relay: R1 }));
    const r = await ingestEvents(env.DB, evs, ctx());
    expect(r.accepted).toBe(INGEST_LIMITS.perPubkeyPerDay);
    expect(r.reasons["rate-limited pubkey"]).toBe(3);
  });
});

describe("proof checks", () => {
  it("R6-001 repro: one public preimage verifies only the first key; replays by sybil keys get no verified weight", async () => {
    const pre = bytesToHex(secp.utils.randomSecretKey()); const hash = bytesToHex(sha256(hexToBytes(pre)));
    const node = key(); const owner = key();
    const ful = sign(owner, 421, [aTag(), ["r", DOM], ["bolt11", encodeBolt11ForTest(node, "lnbc10u", hash)]], "here you go");
    await env.DB.prepare("INSERT INTO claims (d, pubkey, nip05, checked_at) VALUES (?,?,?,?)").bind(DOM, bytesToHex(secp.schnorr.getPublicKey(owner)), `_@${DOM}`, 1).run();
    await ingestEvents(env.DB, [{ ev: sign(owner, 31420, [["d", DOM], ["ln_node", bytesToHex(secp.getPublicKey(node))]], JSON.stringify({ d: DOM })), relay: R1 }, { ev: ful, relay: R1 }], ctx());
    const buyer = key(); const first = review(buyer, [["e", ful.id, R1, "fulfillment"], ["preimage", pre]]);
    const sybils = Array.from({ length: 5 }, () => review(key(), [["e", ful.id, R1, "fulfillment"], ["preimage", pre]]));
    const again = review(buyer, [["e", ful.id, R1, "fulfillment"], ["preimage", pre]], "update"); // same key, later note: still its proof
    await ingestEvents(env.DB, [{ ev: first, relay: R1 }], ctx());
    await ingestEvents(env.DB, [...sybils, again].map((ev) => ({ ev, relay: R1 })), ctx());
    const st = await env.DB.prepare("SELECT id, pubkey, proof_status FROM reviews").all<{ id: string; pubkey: string; proof_status: string }>();
    const by = Object.fromEntries((st.results ?? []).map((r) => [r.id, r.proof_status]));
    expect(by[first.id]).toBe("verified-preimage"); expect(by[again.id]).toBe("verified-preimage");
    for (const s of sybils) expect(by[s.id]).toBe("replayed-proof");
    // same through POST /reviews
    const late = review(key(), [["e", ful.id, R1, "fulfillment"], ["preimage", pre]]);
    expect((await SELF.fetch("https://example.com/reviews", { method: "POST", body: JSON.stringify(late), headers: { "Content-Type": "application/json" } })).status).toBe(201);
    expect((await env.DB.prepare("SELECT proof_status FROM reviews WHERE id = ?").bind(late.id).first<{ proof_status: string }>())?.proof_status).toBe("replayed-proof");
  });
  it("KM-001 preimage: verified only when the invoice is node-signed by the claimed store's ln_node key", async () => {
    const pre = bytesToHex(secp.utils.randomSecretKey());
    const hash = bytesToHex(sha256(hexToBytes(pre)));
    const node = key(); const nodePub = bytesToHex(secp.getPublicKey(node));
    const inv = encodeBolt11ForTest(node, "lnbc10u", hash);
    expect(decodeBolt11(inv)?.amount_msat).toBe(1_000_000);
    const owner = key(), buyer = key();
    const ful = sign(owner, 421, [aTag(), ["r", DOM], ["bolt11", inv]], "here you go");
    const forgedFul = sign(key(), 421, [aTag(), ["r", DOM], ["bolt11", fakeBolt11(hash)]], "forged");
    const good = review(buyer, [["e", ful.id, R1, "fulfillment"], ["preimage", pre]]);
    const wrong = review(key(), [["e", ful.id, R1, "fulfillment"], ["preimage", "11".repeat(32)]]);
    const forged = review(key(), [["e", forgedFul.id, R1, "fulfillment"], ["preimage", pre]]);
    // before the store binds its node: a valid invoice is still only a claim
    expect(checkProof(good, ful, null)).toBe("unverified-claim");
    await env.DB.prepare("INSERT INTO claims (d, pubkey, nip05, checked_at) VALUES (?,?,?,?)").bind(DOM, bytesToHex(secp.schnorr.getPublicKey(owner)), `_@${DOM}`, 1).run();
    const rec = sign(owner, 31420, [["d", DOM], ["ln_node", nodePub]], JSON.stringify({ d: DOM }));
    await ingestEvents(env.DB, [{ ev: rec, relay: R1 }, { ev: ful, relay: R1 }, { ev: forgedFul, relay: R1 }], ctx());
    await ingestEvents(env.DB, [{ ev: good, relay: R1 }, { ev: wrong, relay: R1 }, { ev: forged, relay: R1 }], ctx());
    const st = await env.DB.prepare("SELECT pubkey, proof_status FROM reviews").all<{ pubkey: string; proof_status: string }>();
    const by = Object.fromEntries((st.results ?? []).map((r) => [r.pubkey, r.proof_status]));
    expect(by[good.pubkey]).toBe("verified-preimage");
    expect(by[wrong.pubkey]).toBe("unverified-claim");
    expect(by[forged.pubkey]).toBe("unverified-claim"); // zero-signature invoice (audit KM-001 repro)
    const c = await getCommunity(env.DB, DOM, OUR);
    expect(c.verified_payments).toBe(1);
  });
  it("KM-001 zap: verified only when the 9735 is signed by the store's bound zap key (NIP-57)", () => {
    const ful = sign(key(), 421, [aTag()], "f");
    const lnurl = key(); const lnurlPk = bytesToHex(secp.schnorr.getPublicKey(lnurl)); const node = key();
    const req = sign(key(), 9734, [["e", ful.id], ["amount", "2100000"]]);
    const desc = JSON.stringify(req);
    const inv = encodeBolt11ForTest(node, "lnbc21u", "ab".repeat(32), { descriptionHashHex: bytesToHex(sha256(new TextEncoder().encode(desc))) });
    const receipt = sign(lnurl, 9735, [["e", ful.id], ["bolt11", inv], ["description", desc]], "");
    const attacker = sign(key(), 9735, [["e", ful.id], ["bolt11", inv], ["description", desc]], "");
    const rv = review(key(), [["e", ful.id, R1, "fulfillment"], ["zap", receipt.id]]);
    const rvA = review(key(), [["e", ful.id, R1, "fulfillment"], ["zap", attacker.id]]);
    const bind = { nodes: new Set<string>(), zapKeys: new Set([lnurlPk]) };
    expect(checkProof(rv, ful, receipt, bind)).toBe("verified-zap");
    expect(checkProof(rv, ful, receipt)).toBe("unverified-claim"); // no binding
    expect(checkProof(rvA, ful, attacker, bind)).toBe("unverified-claim"); // any-key receipt (audit KM-001 zap variant)
    expect(checkProof(rv, ful, null, bind)).toBe("unverified-claim");
    expect(checkProof(review(key(), [["cashu", "x"]]), null, null)).toBe("unverified-claim");
  });
});

/** Fake relay over a WebSocketPair inside the Workers runtime: answers REQ with matching stored events, then EOSE. */
function fakeRelay(events: Ev[], seen: unknown[][]): Connect {
  return async () => {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    server.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as unknown[];
      seen.push(msg);
      if (msg[0] !== "REQ") return;
      const sub = msg[1] as string; const f = msg[2] as { kinds?: number[]; since?: number };
      for (const ev of events) if ((!f.kinds || f.kinds.includes(ev.kind)) && (!f.since || ev.created_at >= f.since)) server.send(JSON.stringify(["EVENT", sub, ev]));
      server.send(JSON.stringify(["EOSE", sub]));
    });
    client.accept();
    return client as never;
  };
}

describe("integration: catch-up against a local fake relay", () => {
  it("ingests from two relays, records relay sets, updates state, and surfaces in /stats/ingest.json and /check", async () => {
    const ours = sign(key(), 31420, [["d", DOM]], JSON.stringify({ d: DOM }));
    const rv1 = review(key(), [], "fast checkout", "card", "checkout");
    const rv2 = review(key(), [], "worked", "card", "paid");
    const junk = { ...review(key()), sig: "00".repeat(64) };
    const seen: unknown[][] = [];
    const c = ctx(); c.ourPubkey = ours.pubkey;
    const res = await catchUp(env.DB, [R1, R2], c, fakeRelay([ours, rv1, rv2, junk as Ev], seen), 3000);
    // relays are read in parallel, so either may win the insert; the other sees duplicates
    expect(res[R1]!.accepted + res[R2]!.accepted).toBe(3);
    expect(res[R1]!.rejected).toBeGreaterThanOrEqual(1); // fake relay replays per filter
    const rel = await env.DB.prepare("SELECT relays FROM nostr_events WHERE id = ?").bind(rv1.id).first<{ relays: string }>();
    expect(rel!.relays.split(",").sort()).toEqual([R1, R2]);
    expect(seen.some((m) => m[0] === "REQ")).toBe(true);
    expect(seen.some((m) => m[0] === "CLOSE")).toBe(true);
    const st = await env.DB.prepare("SELECT relay, last_seen, last_ok_at FROM ingest_state ORDER BY relay").all<{ relay: string; last_seen: number; last_ok_at: number }>();
    expect(st.results).toHaveLength(2);
    expect(st.results![0]!.last_seen).toBeGreaterThan(0);
    // second pass uses since = last_seen - overlap
    const seen2: unknown[][] = [];
    await catchUp(env.DB, [R1], c, fakeRelay([], seen2), 3000);
    const since = (seen2.find((m) => m[0] === "REQ")![2] as { since: number }).since;
    expect(since).toBe(st.results![0]!.last_seen - INGEST_LIMITS.catchupOverlapS);
    const stats = await (await SELF.fetch("https://example.com/stats/ingest.json")).json<{ by_kind: Record<string, number> }>();
    expect(stats.by_kind["422"]).toBe(2);
    const chk = await (await SELF.fetch(`https://example.com/check?domain=${DOM}`)).json<{ community: { reviewers: number; attempts: Record<string, number> } }>();
    expect(chk.community.reviewers).toBe(2);
    expect(chk.community.attempts.paid).toBe(1);
    const html = await (await SELF.fetch(`https://example.com/merchant/${DOM}`, { headers: { Accept: "text/html" } })).text();
    expect(html).toContain("What agents report");
    expect(html).toContain("KlickyMart crawl");
  }, 20_000);
  it("filters ask for 31420 (all authors), 420/421/422 by r and by our a-tags", () => {
    const f = buildFilters(ctx(), 100);
    expect(f[0]).toEqual({ kinds: [31420], since: 100 });
    expect((f[1] as { "#r": string[] })["#r"]).toContain(DOM);
    expect((f[2] as { "#a": string[] })["#a"]).toContain(`31420:${OUR}:${DOM}`);
  });
  it("timeout path records an error instead of hanging", async () => {
    const hang: Connect = async () => { const p = new WebSocketPair(); const [c, s] = Object.values(p) as [WebSocket, WebSocket]; s.accept(); c.accept(); return c as never; };
    const r = await catchUp(env.DB, [R1], ctx(), hang, 200);
    expect(r[R1]!.error).toContain("timeout");
  });
});
