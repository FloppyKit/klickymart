import { facProof } from "./helpers/fac-proof";
import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { nostrEventId, verifyNostrEvent } from "../src/nostr-verify";
import { ingestEvents, buildFilters, type Ev, type IngestCtx } from "../src/relay-ingest";
import { facilitate, checkFacilitationProof, FACILITATOR_NPUB } from "../src/facilitate";
import { encodeBolt11ForTest } from "../src/bolt11";
import { loadTips, summarize, curators, tipWeight } from "../src/tips";
import { loadAggregates, experienceTemplate } from "../src/experience";

const DOM = "store.google.com";
const OUR = "3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242";
const ctx = (): IngestCtx => ({ domains: new Set([DOM]), ourPubkey: OUR });
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
const NODE = key();
/** A proper NIP-57 receipt: node-signed invoice whose description_hash commits to the 9734 request. */
function zap(lnurlSk: Uint8Array, payerSk: Uint8Array, note: { id: string; pubkey: string }, hrp = "lnbc10u", recipient = note.pubkey): Ev {
  const target = note.id;
  const req = sign(payerSk, 9734, [["p", recipient], ["e", target], ["amount", "1000000"], ["relays", "wss://r.test"]]);
  const desc = JSON.stringify(req);
  const inv = encodeBolt11ForTest(NODE, hrp, bytesToHex(sha256(new TextEncoder().encode(req.id + "x"))), { descriptionHashHex: bytesToHex(sha256(new TextEncoder().encode(desc))) });
  return sign(lnurlSk, 9735, [["p", recipient], ["e", target], ["bolt11", inv], ["description", desc], ["P", req.pubkey]]);
}
/** fake LNURL-pay endpoint: every lud16 resolves to the given nostrPubkey */
const lnurlFetcher = (nostrPubkey: string) => (async () => Response.json({ allowsNostr: true, nostrPubkey, callback: "https://ln.example/cb" })) as never;
const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace; };
const SK = bytesToHex(key()); // local test key only
const known = (d: string) => d === DOM;

beforeEach(async () => {
  for (const t of ["nostr_events", "site_records", "ingest_state", "reviews", "experiences", "claims", "lnurl_cache"]) { try { await env.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ } }
});

describe("POST /facilitate (facilitated 421)", () => {
  it("KM-001/002: preimage matching a node-signed bolt11 -> signed 421 labelled unverified-claim (never verified for an unclaimed store)", async () => {
    const pre = bytesToHex(key()); const inv = encodeBolt11ForTest(NODE, "lnbc10u", bytesToHex(sha256(hexToBytes(pre))));
    expect(checkFacilitationProof({ type: "preimage", preimage: pre, bolt11: fakeBolt11(bytesToHex(sha256(hexToBytes(pre)))) })).toMatchObject({ ok: false, code: "bad_proof" }); // zero-sig invoice
    const agent = pk(key());
    const r = await facilitate({ DB: env.DB, KV: kv(), FACILITATOR_SK_HEX: SK, SUBMIT_SALT: "test-salt" }, { domain: DOM, agent_pubkey: agent, proof: { type: "preimage", preimage: pre, bolt11: inv } }, known, "1.1.1.1");
    expect(r.status).toBe(200);
    const ev = r.body.event as Ev;
    expect(verifyNostrEvent(ev as never, 421).ok).toBe(true);
    expect(ev.pubkey).toBe(pk(hexToBytes(SK)));
    const t = Object.fromEntries(ev.tags.map((x) => [x[0], x[1]]));
    expect(t).toMatchObject({ r: DOM, on_behalf_of: DOM, role: "facilitator", verification: "unverified-claim", p: agent, proof: "preimage", amount: "1000000" });
    expect(r.body.published).toBe(false);
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain("store confirmed");
  });
  it("wrong preimage is refused; hash-only proof is labelled unverified-claim", async () => {
    const inv = encodeBolt11ForTest(NODE, "lnbc10u", "ab".repeat(32));
    expect(checkFacilitationProof({ type: "preimage", preimage: "11".repeat(32), bolt11: inv })).toMatchObject({ ok: false, code: "proof_mismatch" });
    const r = await facilitate({ DB: env.DB, KV: kv(), FACILITATOR_SK_HEX: SK, SUBMIT_SALT: "test-salt" }, { domain: DOM, agent_pubkey: pk(key()), proof: facProof() }, known, "ip");
    expect(r.status).toBe(200);
    expect((r.body.event as Ev).tags).toContainEqual(["verification", "unverified-claim"]);
    expect(String(r.body.label)).toMatch(/UNVERIFIED CLAIM/);
  });
  it("KM-001/002: well-formed NIP-57 zap receipt -> unverified-claim only; unsigned zap request refused", () => {
    const rc = zap(key(), key(), { id: "aa".repeat(32), pubkey: "bb".repeat(32) });
    expect(checkFacilitationProof({ type: "zap", receipt: rc })).toMatchObject({ ok: true, verification: "unverified-claim" });
    const forged = sign(key(), 9735, [["bolt11", fakeBolt11("cd".repeat(32))], ["description", JSON.stringify({ kind: 9734, pubkey: "00".repeat(32), tags: [], content: "", created_at: 1, id: "00".repeat(32), sig: "00".repeat(64) })]]);
    expect(checkFacilitationProof({ type: "zap", receipt: forged })).toMatchObject({ ok: false });
  });
  it("refuses secret keys, unknown domains, claimed stores; rate-limits per agent+domain", async () => {
    const e = { DB: env.DB, KV: kv(), FACILITATOR_SK_HEX: SK, SUBMIT_SALT: "test-salt" };
    const agent = pk(key()); const proof = facProof();
    expect((await facilitate(e, { domain: DOM, agent_pubkey: agent, proof, nsec: "x" } as never, known, "ip")).body.error).toMatchObject({ code: "secret_sent" });
    expect((await facilitate(e, { domain: "nope.example", agent_pubkey: agent, proof }, known, "ip")).status).toBe(400);
    expect((await facilitate(e, { domain: DOM, agent_pubkey: agent, proof }, known, "ip")).status).toBe(200);
    expect((await facilitate(e, { domain: DOM, agent_pubkey: agent, proof }, known, "ip")).status).toBe(429);
    await env.DB.prepare("INSERT INTO claims (d, pubkey, nip05, checked_at) VALUES (?,?,?,?)").bind(DOM, "ab".repeat(32), "_", 1).run();
    expect((await facilitate(e, { domain: DOM, agent_pubkey: pk(key()), proof }, known, "ip2")).status).toBe(409);
  });
  it("GET /facilitate publishes only the npub; POST without the secret configured is 503 (never signs)", async () => {
    const g = await (await SELF.fetch("https://example.com/facilitate")).json() as Record<string, unknown>;
    expect(g.facilitator_npub).toBe(FACILITATOR_NPUB);
    const p = await SELF.fetch("https://example.com/facilitate", { method: "POST", body: JSON.stringify({ domain: "nope.example", agent_pubkey: "00".repeat(32), proof: facProof() }) });
    expect([400, 503]).toContain(p.status);
  });
});

describe("tips on 422 notes (NIP-57)", () => {
  it("counts tips, ignores self-zaps, caps weight, exposes curators, and boosts chart weight", async () => {
    const a = key(), b = key(), lnurl = key();
    const n1 = sign(a, 422, [["r", DOM], ["depth", "paid"], ["basis", "visit"], ["rating", "5", "5"], ["attempt", "paid"]], "great");
    const n2 = sign(b, 422, [["r", DOM], ["depth", "browse"], ["basis", "visit"], ["rating", "2", "5"], ["attempt", "browse"]], "meh");
    const prof = sign(a, 0, [], JSON.stringify({ lud16: "a@ln.example" }));
    await ingestEvents(env.DB, [n1, n2, prof].map((ev) => ({ ev, relay: "wss://r.test" })), ctx());
    expect(JSON.stringify(buildFilters(ctx(), 0, [n1.id]))).toContain(n1.id);
    const tippers = Array.from({ length: 7 }, key);
    for (const t of tippers) { // tippers KlickyMart first saw > 30 days ago (ingest time), with other public activity
      await env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,content,raw_json,source,received_day,basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(bytesToHex(key()), 422, "other.example", pk(t), 1, 0, "", "{}", "post", "2026-01-01", "visit").run();
      await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)")
        .bind(bytesToHex(key()), 1, pk(t), 1, null, "{}", Math.floor(Date.now() / 1000) - 60 * 86400, "wss://r.test").run();
    }
    const receipts = [...tippers.map((t) => zap(lnurl, t, n1)), zap(lnurl, tippers[0]!, n1), zap(lnurl, a, n1)];
    const res = await ingestEvents(env.DB, receipts.map((ev) => ({ ev, relay: "wss://r.test" })), { ...ctx(), fetcher: lnurlFetcher(pk(lnurl)) });
    expect(res.accepted).toBe(receipts.length); // receipts are not per-pubkey rate limited
    const t = await loadTips(env.DB, DOM);
    const s = summarize(t.byNote.get(n1.id)!);
    expect(s).toMatchObject({ tips: 8, sats: 8000, distinct_tippers: 7, validated_tippers: 7, self_zaps_ignored: 1, weight: 1.5 });
    expect(tipWeight(2)).toBeCloseTo(1.2);
    expect(curators(t).length).toBe(7);
    const agg = (await loadAggregates(env.DB, [DOM], Date.now(), { minKeyAgeS: 0 })).get(DOM)!;
    expect(agg.tips.sats).toBe(8000);
    expect(agg.success_score).toBe(0.6); // 1.5 / (1.5 + 1)
    const tj = await (await SELF.fetch(`https://example.com/tips.json?domain=${DOM}`)).json() as { per_review: { id: string; sats: number }[] };
    expect(tj.per_review.find((x) => x.id === n1.id)?.sats).toBe(8000);
    const cj = await (await SELF.fetch("https://example.com/curators.json")).json() as { curators: unknown[] };
    expect(cj.curators.length).toBe(7);
  });
  it("KM-003: receipts not signed by the author's LNURL key, and backdated fresh tippers, add no weight", async () => {
    const a = key(), lnurl = key(), attacker = key();
    const n1 = sign(a, 422, [["r", DOM], ["depth", "paid"], ["basis", "visit"], ["rating", "5", "5"], ["attempt", "paid"]], "great");
    const prof = sign(a, 0, [], JSON.stringify({ lud16: "a@ln.example" }));
    await ingestEvents(env.DB, [n1, prof].map((ev) => ({ ev, relay: "wss://r.test" })), ctx());
    const old = Math.floor(Date.now() / 1000) - 400 * 86400;
    const tippers = Array.from({ length: 5 }, key);
    const backdated = tippers.map((t) => sign(t, 0, [], "{}", old)); // mintable "history"
    const forged = tippers.map((t) => zap(attacker, t, n1)); // self-made receipts
    const legit = tippers.map((t) => zap(lnurl, t, n1)); // real LNURL key, but fresh tippers
    await ingestEvents(env.DB, [...backdated, ...forged, ...legit].map((ev) => ({ ev, relay: "wss://r.test" })), { ...ctx(), fetcher: lnurlFetcher(pk(lnurl)) });
    const lt = await loadTips(env.DB, DOM);
    const s = summarize(lt.byNote.get(n1.id)!);
    expect(s.validated_tippers).toBe(5); // only the LNURL-signed receipts validate
    expect(s.bonus_tippers).toBe(0); // backdated kind-0 is not history: first_seen is now
    expect(s.weight).toBe(1);
  });
  it("R12-002: receipts paying someone other than the note author, or signed by a shared custodial key, add no weight", async () => {
    const a = key(), c = key(), custodial = key();
    const n1 = sign(a, 422, [["r", DOM], ["depth", "paid"], ["basis", "visit"], ["rating", "5", "5"], ["attempt", "paid"]], "great");
    const profA = sign(a, 0, [], JSON.stringify({ lud16: "a@custodial.example" }));
    const profC = sign(c, 0, [], JSON.stringify({ lud16: "c@custodial.example" }));
    const nc = sign(c, 422, [["r", DOM], ["depth", "browse"], ["basis", "visit"], ["rating", "4", "5"], ["attempt", "browse"]], "ok");
    await ingestEvents(env.DB, [n1, nc, profA, profC].map((ev) => ({ ev, relay: "wss://r.test" })), ctx());
    // attacker c zaps their own wallet (p = c) but tags the victim's note
    const misdirected = zap(custodial, c, n1, "lnbc10u", pk(c));
    await ingestEvents(env.DB, [misdirected].map((ev) => ({ ev, relay: "wss://r.test" })), { ...ctx(), fetcher: lnurlFetcher(pk(custodial)) });
    let lt = await loadTips(env.DB, DOM);
    expect(lt.byNote.get(n1.id)!.every((t) => !t.validated)).toBe(true);
    // a correctly addressed receipt is still not counted when the signing key serves several recipients
    await env.DB.prepare("DELETE FROM lnurl_cache").run();
    await env.DB.prepare("INSERT INTO lnurl_cache (lud16, nostr_pubkey, checked_at) VALUES (?,?,?),(?,?,?)").bind("a@custodial.example", pk(custodial), Math.floor(Date.now() / 1000), "c@custodial.example", pk(custodial), Math.floor(Date.now() / 1000)).run();
    await ingestEvents(env.DB, [zap(custodial, key(), n1)].map((ev) => ({ ev, relay: "wss://r.test" })), { ...ctx(), fetcher: lnurlFetcher(pk(custodial)) });
    lt = await loadTips(env.DB, DOM);
    expect(lt.byNote.get(n1.id)!.length).toBe(2);
    expect(lt.byNote.get(n1.id)!.every((t) => !t.validated)).toBe(true);
    expect(summarize(lt.byNote.get(n1.id)!).weight).toBe(1);
  });
  it("template accepts a lud16 tag and rejects junk", () => {
    const ok = experienceTemplate({ domain: DOM, depth: "browse", lud16: "Me@Getalby.com" }, null);
    expect(ok.ok && (ok.value.unsigned_event as { tags: string[][] }).tags).toContainEqual(["lud16", "me@getalby.com"]);
    const bad = experienceTemplate({ domain: DOM, depth: "browse", lud16: "not an address" }, null);
    expect(bad.ok && JSON.stringify(bad.value)).toContain("lud16 ignored");
  });
});
