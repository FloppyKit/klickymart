import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson } from "../src/endpoint-binding";
import { appendKeyRecord, checkRecord, classifyResult, loadKeyRecords, makePin, makeRevoke, makeRotate, recordId, verifyKeyRecords, ROTATE_TAG, type KeyRecord } from "../src/key-records";
import { buildResult, signHead, signResult, type HeadPayload, type Signed } from "../src/signed-result";
import { openStoreRoute, keyRecordsRoute } from "../src/open-store";
import { handleRequest } from "../src/router";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

// Throwaway keys generated per run. Nothing here reads /home/box/secrets.
const key = () => secp.utils.randomSecretKey();
const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
const NOW = 1_800_000_000;
const DG = "d1".repeat(32);
const H0 = "00".repeat(32);
function heads(sks: Uint8Array[], n: number): Signed<HeadPayload>[] {
  const out: Signed<HeadPayload>[] = [];
  for (let i = 0; i < n; i++) out.push(signHead({ type: "klickymart-head", v: 1, snapshot_id: `s${i}`, snapshot_digest: DG, sequence: i, created_at: NOW + i, expires_at: NOW + i + 1000, prev_head: i ? `${i - 1}:s${i - 1}` : null }, bytesToHex(sks[i]!)));
  return out;
}
const resultFor = (h: Signed<HeadPayload>, sk: Uint8Array, cert: string | null = null) => signResult(buildResult(null, "ab".repeat(32), "nonce-123", h.payload, NOW, cert), bytesToHex(sk));

describe("M3 key records: verifier", () => {
  it("happy path pin -> rotate -> rotate (order-independent)", () => {
    const [a, b, c] = [key(), key(), key()];
    const p = makePin(a, NOW), r1 = makeRotate(a, b, p.id, H0, NOW + 1), r2 = makeRotate(b, c, r1.id, H0, NOW + 2);
    const st = verifyKeyRecords([r2, p, r1]);
    expect(st).toMatchObject({ ok: true, current: pk(c), status: "active", cert_hash: r2.id });
    if (st.ok) expect(st.chain.map((l) => l.pubkey)).toEqual([pk(a), pk(b), pk(c)]);
  });
  it("rotate missing the new-key signature is rejected", () => {
    const [a, b] = [key(), key()]; const p = makePin(a, NOW); const r = makeRotate(a, b, p.id, H0, NOW + 1);
    const { sig_new, ...noNew } = r; void sig_new;
    expect(verifyKeyRecords([p, noNew])).toEqual({ ok: false, error: "missing or bad sig_new" });
    // new sig made by the old key (no proof of possession of the new key)
    const fake = { ...r, sig_new: r.sig_old };
    expect(verifyKeyRecords([p, fake])).toEqual({ ok: false, error: "bad sig_new" });
  });
  it("forged old-key signature is rejected", () => {
    const [a, b, m] = [key(), key(), key()]; const p = makePin(a, NOW);
    const body = { type: "km-key-rotate" as const, v: 1 as const, old_pubkey: pk(a), new_pubkey: pk(b), prev: p.id, last_good_head: H0, created_at: NOW + 1 };
    const m2 = (sk: Uint8Array) => bytesToHex(secp.schnorr.sign(sha256(utf8ToBytes(`${ROTATE_TAG}\n${canonicalJson(body)}`)), sk));
    expect(verifyKeyRecords([p, { id: recordId(body), body, sig_old: m2(m), sig_new: m2(b) }])).toEqual({ ok: false, error: "bad sig_old" });
  });
  it("signature under another type's domain tag is rejected", () => {
    const a = key(); const p = makePin(a, NOW);
    const rv = makeRevoke(a, H0, NOW); // revoke sig over a pin body must not verify
    expect(checkRecord({ ...p, sig: rv.sig }).ok).toBe(false);
  });
  it("fork (two rotates from the same prev) fails closed", () => {
    const [a, b, c] = [key(), key(), key()]; const p = makePin(a, NOW);
    expect(verifyKeyRecords([p, makeRotate(a, b, p.id, H0, NOW + 1), makeRotate(a, c, p.id, H0, NOW + 1)])).toMatchObject({ ok: false, error: expect.stringContaining("fork") });
  });
  it("broken prev link, second pin, unknown type and unknown fields are rejected", () => {
    const [a, b] = [key(), key()]; const p = makePin(a, NOW);
    expect(verifyKeyRecords([p, makeRotate(a, b, "11".repeat(32), H0, NOW)])).toMatchObject({ ok: false, error: expect.stringContaining("broken prev link") });
    expect(verifyKeyRecords([p, makePin(b, NOW)])).toEqual({ ok: false, error: "more than one pin" });
    expect(verifyKeyRecords([{ ...p, body: { ...p.body, type: "km-key-other" } }])).toMatchObject({ ok: false, error: expect.stringContaining("unknown type") });
    expect(verifyKeyRecords([{ ...p, note: "x" }])).toEqual({ ok: false, error: "unknown field note" });
    const body = { ...p.body, extra: 1 };
    expect(verifyKeyRecords([{ id: recordId(body), body, sig: p.sig }])).toEqual({ ok: false, error: "unknown field body.extra" });
    const { created_at, ...noTs } = p.body; void created_at;
    expect(verifyKeyRecords([{ id: recordId(noTs), body: noTs, sig: p.sig }])).toEqual({ ok: false, error: "missing or bad body.created_at" });
  });
  it("JCS stability: key order does not change the id; known vector", () => {
    const body = { type: "km-key-pin", v: 1, pubkey: "aa".repeat(32), created_at: 1 };
    const shuffled = { created_at: 1, pubkey: "aa".repeat(32), v: 1, type: "km-key-pin" };
    expect(canonicalJson(body)).toBe(`{"created_at":1,"pubkey":"${"aa".repeat(32)}","type":"km-key-pin","v":1}`);
    expect(recordId(body)).toBe(recordId(shuffled));
    expect(recordId(body)).toBe(bytesToHex(sha256(utf8ToBytes(canonicalJson(body)))));
  });
  it("revoke without a rotate: status revoked", () => {
    const a = key(); const p = makePin(a, NOW);
    expect(verifyKeyRecords([p, makeRevoke(a, H0, NOW + 5)])).toMatchObject({ ok: true, status: "revoked", current: pk(a) });
  });
});

describe("M3 key records: classifyResult with a head chain", () => {
  it("revoke: results at/before last_good_head ok, after it signed_then_revoked; new key ok", () => {
    const [a, b] = [key(), key()];
    const hs = heads([a, a, a, b], 4); // a's head 1 is the last good one; head 2 signed by a after compromise
    const p = makePin(a, NOW), rv = makeRevoke(a, hs[1]!.id, NOW + 10), rot = makeRotate(a, b, p.id, hs[1]!.id, NOW + 10);
    const recs = [p, rot, rv];
    expect(classifyResult(resultFor(hs[0]!, a), hs[0]!, recs, hs).class).toBe("ok");
    expect(classifyResult(resultFor(hs[1]!, a), hs[1]!, recs, hs).class).toBe("ok");
    expect(classifyResult(resultFor(hs[2]!, a), hs[2]!, recs, hs).class).toBe("signed_then_revoked");
    expect(classifyResult(resultFor(hs[3]!, b, rot.id), hs[3]!, recs, hs).class).toBe("ok");
    expect(classifyResult(resultFor(hs[3]!, b, p.id), hs[3]!, recs, hs).class).toBe("unknown_key"); // wrong cert_hash
  });
  it("revoke without rotate: anything after last_good_head fails closed", () => {
    const a = key(); const hs = heads([a, a, a], 3); const recs = [makePin(a, NOW), makeRevoke(a, hs[0]!.id, NOW)];
    expect(classifyResult(resultFor(hs[0]!, a), hs[0]!, recs, hs).class).toBe("ok");
    expect(classifyResult(resultFor(hs[2]!, a), hs[2]!, recs, hs).class).toBe("signed_then_revoked");
    expect(classifyResult(resultFor(hs[2]!, a), hs[2]!, recs, []).class).toBe("signed_then_revoked"); // no chain = no proof
  });
  it("unknown signer and broken records -> unknown_key", () => {
    const [a, x] = [key(), key()]; const hs = heads([x], 1);
    expect(classifyResult(resultFor(hs[0]!, x), hs[0]!, [makePin(a, NOW)], hs).class).toBe("unknown_key");
    expect(classifyResult(resultFor(hs[0]!, x), hs[0]!, [], hs).class).toBe("unknown_key");
  });
  it("ADVERSARIAL (accepted residual): a thief with the key can rotate to its own key; Matt's conflicting rotate = fork = fail closed", () => {
    const [honest, thief, matt2] = [key(), key(), key()];
    const p = makePin(honest, NOW);
    const evil = makeRotate(honest, thief, p.id, H0, NOW + 1);
    // Residual: alone, the thief's rotate verifies and the thief becomes the current key.
    expect(verifyKeyRecords([p, evil])).toMatchObject({ ok: true, current: pk(thief), status: "active" });
    // Kill switch: Matt publishes his own rotate from the same prev -> fork -> nothing verifies.
    const good = makeRotate(honest, matt2, p.id, H0, NOW + 1);
    expect(verifyKeyRecords([p, evil, good])).toMatchObject({ ok: false, error: expect.stringContaining("fork") });
    const hs = heads([thief], 1);
    expect(classifyResult(resultFor(hs[0]!, thief, evil.id), hs[0]!, [p, evil, good], hs).class).toBe("unknown_key");
    // Matt's revoke of the honest key also exists; with the thief's rotate it marks the honest key revoked but does not
    // un-authorize the thief's key (that is what the fork is for).
    expect(verifyKeyRecords([p, evil, makeRevoke(honest, H0, NOW + 2)])).toMatchObject({ ok: true, current: pk(thief) });
  });
});

describe("M3 storage + endpoint", () => {
  // One append-only table per test file: the tests below share it in order.
  const [a, b, c] = [key(), key(), key()]; const p = makePin(a, NOW);
  let rotId = "";
  it("append-only table: valid appends, invalid/fork refused, update/delete aborted", async () => {
    expect(await appendKeyRecord(env.DB, p)).toEqual({ ok: true });
    const r1 = makeRotate(a, b, p.id, H0, NOW + 1); rotId = r1.id;
    expect(await appendKeyRecord(env.DB, r1)).toEqual({ ok: true });
    expect((await appendKeyRecord(env.DB, makeRotate(a, c, p.id, H0, NOW + 2))).ok).toBe(false);
    expect((await appendKeyRecord(env.DB, { ...r1, sig_new: r1.sig_old })).ok).toBe(false);
    await expect(env.DB.prepare("DELETE FROM km_key_records").run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE km_key_records SET type='x'").run()).rejects.toThrow();
    expect((await loadKeyRecords(env.DB)).map((r: KeyRecord) => r.id)).toEqual([p.id, r1.id]);
  });
  it("GET /open-store/keys: off -> 404, on -> records in order, no secrets; cert_hash set on head and result", async () => {
    const base = { ...env } as typeof env;
    const off = await handleRequest(new Request("https://x.test/open-store/keys"), { ...base, KM_KEY_RECORDS: "off" } as never);
    expect(off.status).toBe(404);
    const onRes = await keyRecordsRoute({ ...base, KM_KEY_RECORDS: "on" } as never);
    expect(onRes.status).toBe(200);
    const j = await onRes.json() as { records: KeyRecord[]; state: { current: string; cert_hash: string } };
    expect(j.records.map((r) => r.id)).toEqual([p.id, rotId]);
    expect(j.state).toMatchObject({ current: pk(b), cert_hash: rotId, status: "active" });
    for (const sk of [a, b, c]) expect(JSON.stringify(j)).not.toContain(bytesToHex(sk));
    const viaRouter = await handleRequest(new Request("https://x.test/open-store/keys"), { ...base, KM_KEY_RECORDS: "on" } as never);
    expect(viaRouter.status).toBe(200);
    // cert_hash on signed head + result when the flag is on
    await env.DB.prepare("INSERT INTO snapshot_heads (sequence, snapshot_id, snapshot_digest, created_at, prev_head) VALUES (?,?,?,?,?)").bind(900, "km3@1", DG, Math.floor(Date.now() / 1000), null).run();
    const e = { ...base, KM_SIGNED_RESULTS: "on", KM_KEY_RECORDS: "on", KM_RESULT_SK_HEX: bytesToHex(b) } as never;
    const r = await openStoreRoute("/open-store/binding", new URL(`https://x.test/open-store/binding?pubkey=${"ab".repeat(32)}&nonce=nonce-123`), e);
    expect(r.status).toBe(200);
    const body = await r.json() as { head: Signed<HeadPayload>; result: { payload: { cert_hash: string } } };
    expect(body.head.payload.cert_hash).toBe(rotId);
    expect(body.result.payload.cert_hash).toBe(rotId);
    // the retired (rotated-away) key fails closed too
    const old = await openStoreRoute("/open-store/head", new URL("https://x.test/open-store/head"), { ...base, KM_SIGNED_RESULTS: "on", KM_KEY_RECORDS: "on", KM_RESULT_SK_HEX: bytesToHex(a) } as never);
    expect(old.status).toBe(503);
    // a signing key that is not the records' current key fails closed
    const wrong = await openStoreRoute("/open-store/head", new URL("https://x.test/open-store/head"), { ...base, KM_SIGNED_RESULTS: "on", KM_KEY_RECORDS: "on", KM_RESULT_SK_HEX: bytesToHex(key()) } as never);
    expect(wrong.status).toBe(503);
    // flag off: no cert_hash (M2 behaviour unchanged)
    const m2 = await openStoreRoute("/open-store/head", new URL("https://x.test/open-store/head"), { ...base, KM_SIGNED_RESULTS: "on", KM_KEY_RECORDS: "off", KM_RESULT_SK_HEX: bytesToHex(a) } as never);
    expect(((await m2.json()) as Signed<HeadPayload>).payload.cert_hash).toBeUndefined();
  });
});
