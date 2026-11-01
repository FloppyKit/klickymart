import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  HARD_MAX_S, KEY_STATEMENT_TTL_CAP_S, effectiveExpiry, effectiveTtlCap, addRevkeyRotate, addRevoke, addStatement, currentStatement, evaluate, exportKeyState, handoverProblem,
  importKeyState, keyLifecycleEnabled, makeHandover, makeInception, makeRevkeyRotate, makeRevoke, newKeyState, paymentGateWithKeys,
  pinFromChannels, repin, statementHash, statementStatus, storeKeyRecord, verifyResultWithKeys, type KeyState, type KeyStatement,
} from "../src/key-lifecycle";
import { buildResult, signHead, signResult, type HeadPayload } from "../src/signed-result";
import { openStoreRoute } from "../src/open-store";
import { handleRequest } from "../src/router";

// Throwaway keys, generated in memory per run. No real key is read; nothing touches a relay.
const key = () => secp.utils.randomSecretKey();
const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
const NOW = 1_800_000_000;
const DAY = 86400;

function lineage(n: number) {
  const sks = Array.from({ length: n + 1 }, key); // sks[i] signs statement i; sks[i+1] is pre-announced
  const rev = key();
  const stmts: KeyStatement[] = [makeInception(sks[0]!, pk(sks[1]!), pk(rev), NOW - 20 * 3600, NOW + 5 * DAY)];
  for (let i = 1; i < n; i++) stmts.push(makeHandover(stmts[i - 1]!, sks[i - 1]!, sks[i]!, pk(sks[i + 1]!), pk(rev), NOW - (20 - i) * 3600, NOW + 5 * DAY));
  const st = newKeyState(stmts[0]!.hash);
  for (const s of stmts) expect(addStatement(st, s).outcome).toBe("accepted");
  return { sks, rev, stmts, st };
}

describe("v9.2 §4 acceptance: pre-rotation", () => {
  it("a clean lineage of three statements: last is current, earlier ones superseded", () => {
    const { stmts, st } = lineage(3);
    expect(evaluate(st, NOW).chain.map((c) => c.hash)).toEqual(stmts.map((s) => s.hash));
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[2]!.hash);
    expect(statementStatus(st, stmts[0]!.hash, NOW).status).toBe("superseded");
  });
  it("a handover to a non-announced key is rejected", () => {
    const { sks, rev, stmts, st } = lineage(1);
    const rogue = key();
    const bad = makeHandover(stmts[0]!, sks[0]!, rogue, pk(key()), pk(rev), NOW - DAY, NOW + DAY);
    expect(handoverProblem(stmts[0]!, bad, st)).toMatch(/not pre-announced/);
    addStatement(st, bad);
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[0]!.hash);
  });
  it("a handover without the successor's proof of possession is rejected", () => {
    const { sks, rev, stmts, st } = lineage(1);
    const h = makeHandover(stmts[0]!, sks[0]!, sks[1]!, pk(key()), pk(rev), NOW - DAY, NOW + DAY);
    const noPop = { ...h, sig_self: h.sig_prev! }; // previous key signed twice; new key never signed
    expect(addStatement(st, noPop).outcome).toBe("rejected");
    const noPrev = { ...h, sig_prev: h.sig_self }; // successor signs itself in; previous key never authorised it
    addStatement(st, noPrev);
    expect(handoverProblem(stmts[0]!, noPrev, st)).toMatch(/not signed by the previous key/);
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[0]!.hash);
  });
  it("a self-extended statement is rejected (key cannot re-certify itself or name itself as next)", () => {
    const sk = key(), rev = key();
    expect(addStatement(newKeyState("0".repeat(64)), makeInception(sk, pk(sk), pk(rev), NOW, NOW + DAY)).reason).toMatch(/self-extension/);
    const { sks, stmts, st } = lineage(1);
    const selfH = makeHandover(stmts[0]!, sks[0]!, sks[0]!, pk(key()), pk(rev), NOW - DAY, NOW + 30 * DAY);
    addStatement(st, selfH);
    expect(evaluate(st, NOW).chain.length).toBe(1);
    expect(handoverProblem(stmts[0]!, selfH, st)).toMatch(/not pre-announced/);
  });
  it("an edited statement (same position, same key, new content e.g. longer expiry) -> compromised, fails closed", () => {
    const { sks, rev, stmts, st } = lineage(2);
    const edited = makeHandover(stmts[0]!, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), stmts[1]!.payload.created_at, NOW + 60 * DAY);
    expect(addStatement(st, edited).outcome).toBe("accepted");
    expect(evaluate(st, NOW).compromised).toMatch(/fork|two statements/);
    expect(currentStatement(st, NOW)).toBeNull();
    expect(statementStatus(st, stmts[1]!.hash, NOW).status).toBe("compromised");
  });
  it("expires_at beyond the hard cap is clamped (future-dating can't extend a statement)", () => {
    const sk = key();
    const s = makeInception(sk, pk(key()), pk(key()), NOW - DAY, NOW + 365 * DAY);
    const st = newKeyState(s.hash); addStatement(st, s);
    expect(statementStatus(st, s.hash, NOW).status).toBe("current");
    expect(statementStatus(st, s.hash, NOW - DAY + KEY_STATEMENT_TTL_CAP_S + 1).status).toBe("expired");
  });
  it("a tampered statement (hash/payload mismatch) is rejected", () => {
    const { stmts } = lineage(1);
    const t = { ...stmts[0]!, payload: { ...stmts[0]!.payload, expires_at: NOW + 99 * DAY } };
    expect(addStatement(newKeyState(stmts[0]!.hash), t).outcome).toBe("rejected");
  });
});

describe("rule 1: TTL cap (HARD_MAX_S compiled in; config may only lower it)", () => {
  it("HARD_MAX_S is 7 days and config can lower but never raise it", () => {
    expect(HARD_MAX_S).toBe(604800);
    expect(effectiveTtlCap(undefined)).toBe(HARD_MAX_S);
    expect(effectiveTtlCap("86400")).toBe(86400);
    expect(effectiveTtlCap(3600)).toBe(3600);
    expect(effectiveTtlCap(10 * HARD_MAX_S)).toBe(HARD_MAX_S);
    expect(effectiveTtlCap("9999999999")).toBe(HARD_MAX_S);
    for (const bad of ["", "abc", "-5", "0", "1.5", 0, -1, NaN]) expect(effectiveTtlCap(bad as never)).toBe(HARD_MAX_S);
  });
  it("effective expiry = min(expires_at, created_at + min(HARD_MAX_S, config)); over-long is clamped, not rejected", () => {
    const sk = key();
    const s = makeInception(sk, pk(key()), pk(key()), NOW - DAY, NOW + 365 * DAY);
    const st = newKeyState(s.hash);
    expect(addStatement(st, s).outcome).toBe("accepted"); // not rejected
    expect(effectiveExpiry(s.payload)).toBe(NOW - DAY + HARD_MAX_S);
    expect(statementStatus(st, s.hash, NOW - DAY + HARD_MAX_S).status).toBe("current");
    expect(statementStatus(st, s.hash, NOW - DAY + HARD_MAX_S + 1).status).toBe("expired");
    expect(statementStatus(st, s.hash, NOW + DAY + 1, { ttlCapS: 2 * DAY }).status).toBe("expired"); // lowered
    expect(statementStatus(st, s.hash, NOW - DAY + HARD_MAX_S + 1, { ttlCapS: 30 * DAY }).status).toBe("expired"); // can't raise
    const short = makeInception(sk, pk(key()), pk(key()), NOW - DAY, NOW + 60);
    expect(effectiveExpiry(short.payload)).toBe(NOW + 60); // own expires_at wins when shorter
  });
});

describe("v9.2 §4 acceptance: revocation", () => {
  it("a revoke beats a later-timestamped handover and covers descendants", () => {
    const { sks, rev, stmts, st } = lineage(2);
    expect(addRevoke(st, makeRevoke(rev, stmts[0]!.hash, NOW - 20 * DAY)).outcome).toBe("accepted"); // older timestamp
    const later = makeHandover(stmts[1]!, sks[1]!, sks[2]!, pk(key()), pk(rev), NOW, NOW + DAY);
    addStatement(st, later);
    for (const s of [...stmts, later]) expect(statementStatus(st, s.hash, NOW).status).toBe("revoked");
    expect(currentStatement(st, NOW)).toBeNull();
  });
  it("a revoke arriving before its target still applies when the target shows up", () => {
    const { sks, rev, stmts } = lineage(2);
    const st = newKeyState(stmts[0]!.hash);
    addRevoke(st, makeRevoke(rev, stmts[1]!.hash, NOW));
    addStatement(st, stmts[0]!);
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[0]!.hash);
    addStatement(st, stmts[1]!);
    expect(statementStatus(st, stmts[1]!.hash, NOW).status).toBe("revoked");
    expect(statementStatus(st, stmts[0]!.hash, NOW).status).toBe("superseded");
    void sks;
  });
  it("a revoke from a non-revocation key (e.g. the signing key) has no effect", () => {
    const { sks, stmts, st } = lineage(2);
    addRevoke(st, makeRevoke(sks[1]!, stmts[1]!.hash, NOW));
    addRevoke(st, makeRevoke(key(), stmts[1]!.hash, NOW));
    expect(statementStatus(st, stmts[1]!.hash, NOW).status).toBe("current");
  });
  it("the revocation key cannot certify: a handover signed by it is not part of the lineage", () => {
    const { sks, rev, stmts, st } = lineage(1);
    const viaRev = makeHandover(stmts[0]!, rev, sks[1]!, pk(key()), pk(rev), NOW - DAY, NOW + DAY);
    addStatement(st, viaRev);
    expect(evaluate(st, NOW).chain.length).toBe(1);
    expect(handoverProblem(stmts[0]!, viaRev, st)).toMatch(/not signed by the previous key/);
    // and it cannot be its own signing key
    expect(addStatement(newKeyState("0".repeat(64)), makeInception(rev, pk(key()), pk(rev), NOW, NOW + DAY)).reason).toMatch(/revocation key equals/);
  });
  it("revocation-key rotation needs both keys", () => {
    const { sks, rev, stmts, st } = lineage(1);
    const rev2 = key();
    // only the signing key (the "old rev" half is forged with the signing key)
    const onlySigning = makeRevkeyRotate(stmts[0]!, sks[0]!, sks[0]!, pk(rev2), NOW);
    const forged = { ...onlySigning, payload: { ...onlySigning.payload, old_revocation_key: pk(rev) } };
    expect(addRevkeyRotate(st, forged).outcome).toBe("rejected");
    // only the old revocation key (signing half by a stranger)
    const onlyRev = makeRevkeyRotate(stmts[0]!, key(), rev, pk(rev2), NOW);
    expect(addRevkeyRotate(st, onlyRev).outcome).toBe("accepted"); // stored; signing half checked against the statement
    const h1 = makeHandover(stmts[0]!, sks[0]!, sks[1]!, pk(key()), pk(rev2), NOW - DAY / 2, NOW + DAY);
    expect(handoverProblem(stmts[0]!, h1, st)).toMatch(/revocation key changed without a two-key rotation/);
    // both keys: the next statement must name rev2
    expect(addRevkeyRotate(st, makeRevkeyRotate(stmts[0]!, sks[0]!, rev, pk(rev2), NOW)).outcome).toBe("accepted");
    expect(handoverProblem(stmts[0]!, h1, st)).toBeNull();
    addStatement(st, h1);
    expect(currentStatement(st, NOW)?.hash).toBe(h1.hash);
    addRevoke(st, makeRevoke(rev2, h1.hash, NOW));
    expect(statementStatus(st, h1.hash, NOW).status).toBe("revoked");
  });
  it("revokes survive reinstall: restored state keeps them, and restoring an older backup cannot undo them", () => {
    const { rev, stmts, st } = lineage(2);
    const backupBefore = exportKeyState(st);
    addRevoke(st, makeRevoke(rev, stmts[1]!.hash, NOW));
    const afterReinstall = importKeyState(exportKeyState(st));
    expect(statementStatus(afterReinstall, stmts[1]!.hash, NOW).status).toBe("revoked");
    importKeyState(backupBefore, afterReinstall); // merge an old backup into live state
    expect(statementStatus(afterReinstall, stmts[1]!.hash, NOW).status).toBe("revoked");
    expect(statementStatus(repin(afterReinstall, stmts[0]!.hash), stmts[1]!.hash, NOW).status).toBe("unknown"); // re-pin keeps revokes...
    const rp = repin(afterReinstall, stmts[0]!.hash); for (const s of stmts) addStatement(rp, s);
    expect(statementStatus(rp, stmts[1]!.hash, NOW).status).toBe("revoked"); // ...so they apply again
  });
  it("compromise is sticky across export/import", () => {
    const { sks, rev, stmts, st } = lineage(2);
    addStatement(st, makeHandover(stmts[0]!, sks[0]!, sks[1]!, pk(key()), pk(rev), NOW - DAY, NOW + DAY));
    expect(importKeyState(exportKeyState(st)).compromised).toBeTruthy();
  });
});

describe("rules 3, 4, 6: current revocation key only; forks are terminal", () => {
  it("rule 3: a replaced revocation key can't revoke; the current one can", () => {
    const { sks, rev, stmts, st } = lineage(2);
    const rev2 = key();
    addRevkeyRotate(st, makeRevkeyRotate(stmts[1]!, sks[1]!, rev, pk(rev2), NOW));
    expect(addRevoke(st, makeRevoke(rev, stmts[1]!.hash, NOW)).outcome).toBe("accepted"); // stored, but has no effect
    expect(statementStatus(st, stmts[1]!.hash, NOW).status).toBe("current");
    addRevoke(st, makeRevoke(rev, stmts[0]!.hash, NOW)); // not even on statements from its own era
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[1]!.hash);
    addRevoke(st, makeRevoke(rev2, stmts[1]!.hash, NOW));
    expect(statementStatus(st, stmts[1]!.hash, NOW).status).toBe("revoked");
  });
  it("rule 4: a statement fork is terminal for the whole lineage; both statements kept as evidence", () => {
    const { sks, rev, stmts, st } = lineage(3);
    const good = signedPair(sks[2]!, stmts[2]!.hash);
    expect(verifyResultWithKeys(good.res, good.head, st, HO).ok).toBe(true);
    const twin = makeHandover(stmts[1]!, sks[1]!, sks[2]!, pk(key()), pk(rev), stmts[2]!.payload.created_at, NOW + DAY);
    addStatement(st, twin);
    expect(evaluate(st, NOW).compromised).toBeTruthy();
    for (const s of [...stmts, twin]) expect(statementStatus(st, s.hash, NOW).status).toBe("compromised");
    expect(verifyResultWithKeys(good.res, good.head, st, HO)).toMatchObject({ ok: false, keyStatus: "compromised" });
    const kept = importKeyState(exportKeyState(st)).stmts.map((s) => s.hash);
    expect(kept).toEqual(expect.arrayContaining([stmts[2]!.hash, twin.hash]));
  });
  it("rule 6: two valid conflicting revocation-key rotations for one statement = fork, terminal; both kept", () => {
    const { sks, rev, stmts, st } = lineage(2);
    const a = makeRevkeyRotate(stmts[1]!, sks[1]!, rev, pk(key()), NOW - 10);
    const b = makeRevkeyRotate(stmts[1]!, sks[1]!, rev, pk(key()), NOW); // "more recent" wins nothing
    addRevkeyRotate(st, a);
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[1]!.hash);
    addRevkeyRotate(st, b);
    expect(evaluate(st, NOW).compromised).toMatch(/rotation fork/);
    expect(currentStatement(st, NOW)).toBeNull();
    const good = signedPair(sks[1]!, stmts[1]!.hash);
    expect(verifyResultWithKeys(good.res, good.head, st, HO)).toMatchObject({ ok: false, keyStatus: "compromised" });
    expect(importKeyState(exportKeyState(st)).revkeyRotations.map((r) => r.hash)).toEqual(expect.arrayContaining([a.hash, b.hash]));
  });
  it("rule 6: the same rotation seen twice is not a fork", () => {
    const { sks, rev, stmts, st } = lineage(1);
    const a = makeRevkeyRotate(stmts[0]!, sks[0]!, rev, pk(key()), NOW);
    addRevkeyRotate(st, a); addRevkeyRotate(st, a);
    expect(evaluate(st, NOW).compromised).toBeNull();
  });
});

describe("v9.2 §4 acceptance: first pin", () => {
  const R = "ab".repeat(32), R2 = "cd".repeat(32);
  it("needs two or more agreeing channels; any disagreement or gap fails closed", () => {
    expect(pinFromChannels([{ channel: "https", root: R }, { channel: "nip05", root: R }])).toEqual({ ok: true, root: R });
    expect(pinFromChannels([{ channel: "https", root: R }]).ok).toBe(false);
    expect(pinFromChannels([{ channel: "https", root: R }, { channel: "https", root: R }]).ok).toBe(false);
    expect(pinFromChannels([{ channel: "https", root: R }, { channel: "nip05", root: R2 }]).ok).toBe(false);
    expect(pinFromChannels([{ channel: "https", root: R }, { channel: "nip05", root: R }, { channel: "release", root: null }]).ok).toBe(false);
    expect(pinFromChannels([{ channel: "https", root: R }, { channel: "https", root: R2 }, { channel: "nip05", root: R }]).ok).toBe(false);
  });
});

// ---------------- results under the lifecycle ----------------

const DG = "d1".repeat(32);
function signedPair(sk: Uint8Array, ksh: string | null, opts: { nonce?: string; headKsh?: string | null } = {}) {
  const head: HeadPayload = { type: "klickymart-head", v: 1, snapshot_id: "s1", snapshot_digest: DG, sequence: 3, created_at: NOW - 60, expires_at: NOW + 3600, prev_head: null };
  const hk = opts.headKsh === undefined ? ksh : opts.headKsh; if (hk) head.key_statement_hash = hk;
  const res = buildResult(null, "ee".repeat(32), opts.nonce ?? "nonce-123", head, NOW - 10, ksh);
  return { head: signHead(head, bytesToHex(sk)), res: signResult(res, bytesToHex(sk)) };
}
const HO = { nonce: "nonce-123", nowS: NOW, highWater: 0 };

describe("results bind the key statement", () => {
  it("accepts a result under the current statement, bounded by the statement's expiry", () => {
    const { sks, stmts, st } = lineage(2);
    const { head, res } = signedPair(sks[1]!, stmts[1]!.hash);
    const v = verifyResultWithKeys(res, head, st, HO);
    expect(v.ok).toBe(true);
  });
  it("rejects a result naming a revoked, expired, superseded, unknown or missing statement", () => {
    const { sks, rev, stmts, st } = lineage(2);
    expect(verifyResultWithKeys(signedPair(sks[0]!, stmts[0]!.hash).res, signedPair(sks[0]!, stmts[0]!.hash).head, st, HO)).toMatchObject({ ok: false, keyStatus: "superseded" });
    const nul = signedPair(sks[1]!, null); expect(verifyResultWithKeys(nul.res, nul.head, st, HO).ok).toBe(false);
    const unk = signedPair(sks[1]!, "77".repeat(32)); expect(verifyResultWithKeys(unk.res, unk.head, st, HO)).toMatchObject({ ok: false, keyStatus: "unknown" });
    const good = signedPair(sks[1]!, stmts[1]!.hash);
    expect(verifyResultWithKeys(good.res, good.head, st, { ...HO, nowS: NOW + 6 * DAY })).toMatchObject({ ok: false });
    expect(statementStatus(st, stmts[1]!.hash, NOW + 6 * DAY).status).toBe("expired");
    addRevoke(st, makeRevoke(rev, stmts[1]!.hash, NOW - 1000));
    expect(verifyResultWithKeys(good.res, good.head, st, HO)).toMatchObject({ ok: false, keyStatus: "revoked" });
  });
  it("rejects a result signed by a different key than its statement names, or a head naming another statement", () => {
    const { sks, stmts, st } = lineage(2);
    const wrong = signedPair(sks[0]!, stmts[1]!.hash);
    expect(verifyResultWithKeys(wrong.res, wrong.head, st, HO).ok).toBe(false);
    const split = signedPair(sks[1]!, stmts[1]!.hash, { headKsh: stmts[0]!.hash });
    expect(verifyResultWithKeys(split.res, split.head, st, HO)).toMatchObject({ ok: false, reason: expect.stringMatching(/head/) });
  });
  it("cached acceptance dies when a revoke is seen later (results signed before a revoke are rejected from then on)", () => {
    const { rev, stmts, st } = lineage(2);
    const cached = { acceptUntil: NOW + 300, key_statement_hash: stmts[1]!.hash };
    expect(paymentGateWithKeys(cached, st, NOW)).toBe("use_cache");
    addRevoke(st, makeRevoke(rev, stmts[1]!.hash, NOW));
    expect(paymentGateWithKeys(cached, st, NOW)).toBe("fail_closed");
    expect(paymentGateWithKeys(cached, st, NOW, true)).toBe("relay_only");
  });
  it("rule 2: overlap is 0 and cannot be configured: the old key dies at handover", () => {
    const { sks, stmts, st } = lineage(2);
    const old = signedPair(sks[0]!, stmts[0]!.hash);
    expect(verifyResultWithKeys(old.res, old.head, st, HO)).toMatchObject({ ok: false, keyStatus: "superseded" });
    expect(verifyResultWithKeys(old.res, old.head, st, { ...HO, overlapS: 20 * DAY } as never).ok).toBe(false);
    // the instant the handover is accepted, not at its created_at
    const one = lineage(1); const h = makeHandover(one.stmts[0]!, one.sks[0]!, one.sks[1]!, pk(key()), pk(one.rev), NOW + 30, NOW + DAY);
    const r0 = signedPair(one.sks[0]!, one.stmts[0]!.hash);
    expect(verifyResultWithKeys(r0.res, r0.head, one.st, HO).ok).toBe(true);
    addStatement(one.st, h);
    expect(verifyResultWithKeys(r0.res, r0.head, one.st, HO).ok).toBe(false);
  });
});

describe("adversarial: one operator with ten keys", () => {
  it("cannot run parallel lineages under one pin: a second branch from any statement is a fork -> compromised", () => {
    const { sks, rev, stmts, st } = lineage(3);
    // Operator pre-announced sks[2] at seq1; tries a second seq2 with another key it holds -> rejected (not announced).
    const other = key();
    addStatement(st, makeHandover(stmts[1]!, sks[1]!, other, pk(key()), pk(rev), NOW, NOW + DAY));
    expect(evaluate(st, NOW).compromised).toBeNull();
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[2]!.hash);
    // Same announced key, two different seq2 statements (e.g. to show different expiries to different harnesses) -> compromised.
    addStatement(st, makeHandover(stmts[1]!, sks[1]!, sks[2]!, pk(key()), pk(rev), NOW, NOW + DAY));
    expect(evaluate(st, NOW).compromised).toBeTruthy();
  });
  it("rotating fast through ten keys buys no lifetime: each statement is capped, and the next key must be pre-announced", () => {
    const { st, stmts } = lineage(10);
    expect(evaluate(st, NOW).chain.length).toBe(10);
    for (const s of stmts.slice(0, -1)) expect(statementStatus(st, s.hash, NOW).status).toBe("superseded");
    // A revoke of an early statement kills all ten descendants at once.
    const { rev, st: st2, stmts: s2 } = lineage(10);
    addRevoke(st2, makeRevoke(rev, s2[2]!.hash, NOW));
    expect(s2.slice(2).every((s) => statementStatus(st2, s.hash, NOW).status === "revoked")).toBe(true);
    expect(currentStatement(st2, NOW)).toBeNull();
  });
  it("a stolen revocation key is a kill switch, never a forgery", () => {
    const { rev, stmts, st } = lineage(2);
    const thiefNext = key();
    addStatement(st, makeHandover(stmts[1]!, rev, thiefNext, pk(key()), pk(rev), NOW, NOW + DAY));
    expect(currentStatement(st, NOW)?.hash).toBe(stmts[1]!.hash);
    addRevoke(st, makeRevoke(rev, stmts[1]!.hash, NOW));
    expect(currentStatement(st, NOW)).toBeNull();
  });
});

// ---------------- Worker: switch, storage, routes ----------------

describe("worker: KM_KEY_LIFECYCLE (default off) and /open-store under the lifecycle", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM km_key_records");
    await env.DB.exec("DELETE FROM snapshot_heads");
  });
  it("switch is off unless explicitly on; wrangler vars ship it off", () => {
    expect(keyLifecycleEnabled({})).toBe(false);
    expect(keyLifecycleEnabled({ KM_KEY_LIFECYCLE: "off" })).toBe(false);
    expect(keyLifecycleEnabled({ KM_KEY_LIFECYCLE: "yes" })).toBe(false);
    expect(keyLifecycleEnabled({ KM_KEY_LIFECYCLE: "on" })).toBe(true);
    expect(keyLifecycleEnabled(env as never)).toBe(false);
  });
  it("storage is append-only and refuses invalid records", async () => {
    const { stmts, rev } = lineage(1);
    expect(await storeKeyRecord(env.DB, "statement", stmts[0]!, NOW)).toBe("accepted");
    expect(await storeKeyRecord(env.DB, "statement", stmts[0]!, NOW)).toBe("duplicate");
    expect(await storeKeyRecord(env.DB, "statement", { ...stmts[0]!, sig_self: "00".repeat(64) }, NOW)).toBe("rejected");
    expect(await storeKeyRecord(env.DB, "revoke", makeRevoke(rev, stmts[0]!.hash, NOW), NOW)).toBe("accepted");
  });
  async function setup(n = 2) {
    const L = lineage(n);
    for (const s of L.stmts) await storeKeyRecord(env.DB, "statement", s, NOW);
    await env.DB.prepare("INSERT INTO snapshot_heads (sequence, snapshot_id, snapshot_digest, created_at, prev_head) VALUES (0,'s0',?,?,NULL)").bind(DG, Math.floor(Date.now() / 1000) - 60).run();
    return L;
  }
  const E = (sk: Uint8Array, root: string, extra: Record<string, string> = {}) => ({ ...env, KM_SIGNED_RESULTS: "on", KM_KEY_LIFECYCLE: "on", KM_KEY_ROOT: root, KM_RESULT_SK_HEX: bytesToHex(sk), ...extra }) as never;
  it("off: M2 behaviour unchanged (no key_statement_hash, /open-store/keys 404)", async () => {
    const { sks, stmts } = await setup();
    const e = { ...env, KM_SIGNED_RESULTS: "on", KM_RESULT_SK_HEX: bytesToHex(sks[1]!), KM_KEY_ROOT: stmts[0]!.hash } as never;
    const h = await (await openStoreRoute("/open-store/head", new URL("https://x/open-store/head"), e)).json() as { payload: HeadPayload };
    expect("key_statement_hash" in h.payload).toBe(false);
    expect((await openStoreRoute("/open-store/keys", new URL("https://x/open-store/keys"), e)).status).toBe(404);
  });
  it("on: head and result name the current statement; a harness accepts them", async () => {
    // Statement times are relative to the fixed NOW; use real-clock-relative lineage for the route.
    const t = Math.floor(Date.now() / 1000);
    const sks = [key(), key(), key()], rev = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(rev), t - 2 * DAY, t + 3 * DAY);
    const s1 = makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), t - DAY, t + 3 * DAY);
    for (const s of [s0, s1]) await storeKeyRecord(env.DB, "statement", s, t);
    await env.DB.prepare("INSERT INTO snapshot_heads (sequence, snapshot_id, snapshot_digest, created_at, prev_head) VALUES (0,'s0',?,?,NULL)").bind(DG, t - 60).run();
    const e = E(sks[1]!, s0.hash);
    const r = await openStoreRoute("/open-store/binding", new URL(`https://x/open-store/binding?pubkey=${"ee".repeat(32)}&nonce=nonce-abc`), e);
    expect(r.status).toBe(200);
    const body = await r.json() as { head: never; result: never };
    const keys = await (await openStoreRoute("/open-store/keys", new URL("https://x/open-store/keys"), e)).text();
    const ks = importKeyState(keys);
    expect(ks.root).toBe(s0.hash);
    const v = verifyResultWithKeys(body.result, body.head, ks, { nonce: "nonce-abc", nowS: t, highWater: 0 });
    expect(v).toMatchObject({ ok: true });
    // after a revoke the Worker refuses to sign (fail closed) and the cached result dies at the harness
    await storeKeyRecord(env.DB, "revoke", makeRevoke(rev, s1.hash, t), t);
    expect((await openStoreRoute("/open-store/head", new URL("https://x/open-store/head"), e)).status).toBe(503);
  });
  it("on: fails closed without a root, with the wrong signing key, or when compromised", async () => {
    const { sks, rev, stmts } = await setup();
    expect((await openStoreRoute("/open-store/head", new URL("https://x/open-store/head"), E(sks[1]!, ""))).status).toBe(503);
    // statements in setup() are anchored to the fixed NOW (2027); the route uses the real clock, so build one for now
    const t = Math.floor(Date.now() / 1000);
    const a = key(), b = key();
    const s0 = makeInception(a, pk(b), pk(rev), t - DAY, t + DAY);
    await storeKeyRecord(env.DB, "statement", s0, t);
    expect((await openStoreRoute("/open-store/head", new URL("https://x/open-store/head"), E(sks[1]!, s0.hash))).status).toBe(503); // wrong key
    expect((await openStoreRoute("/open-store/head", new URL("https://x/open-store/head"), E(a, s0.hash))).status).toBe(200);
    await storeKeyRecord(env.DB, "statement", makeInception(a, pk(key()), pk(rev), t - DAY, t + DAY), t); // second inception
    const r = await openStoreRoute("/open-store/head", new URL("https://x/open-store/head"), E(a, s0.hash));
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/compromised/);
    void stmts;
  });
  it("router: /open-store/keys does not exist with the shipped defaults", async () => {
    const r = await handleRequest(new Request("https://klickymart.com/open-store/keys"), env as never);
    expect(r.status).not.toBe(200);
  });
  it("statementHash is stable over the canonical payload", () => {
    const { stmts } = lineage(1);
    expect(statementHash(stmts[0]!.payload)).toBe(stmts[0]!.hash);
  });
});
