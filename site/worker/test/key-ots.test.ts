import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  addRevkeyRotate, addRevoke, addStatement, archiveResult, currentStatement, evaluate, exportKeyState, importKeyState,
  makeHandover, makeInception, makeRevkeyRotate, makeRevoke, newKeyState, stageHandover, statementStatus, storeKeyRecord,
  verifyResultWithKeys, type KeyStatement,
} from "../src/key-lifecycle";
import {
  CONF, FRESH_K_DEFAULT, FRESH_K_MAX, anchorOf, combineHeaderSources, effectiveFreshK, isStale, judgeOldKeyRevoke,
  otsEnabled, stampInBackground, stampRecord, strictlyBefore, upgradeStamps, type BlockHeaderSource, type NotBefore,
  type OtsCalendar, type OtsContext, type OtsProofVerifier,
} from "../src/key-ots";
import { buildResult, signHead, signResult, type HeadPayload } from "../src/signed-result";
import { openStoreRoute, writeDailyHead } from "../src/open-store";

// Everything is mocked: throwaway keys, a fake chain of block hashes, a fake proof format. No network.
const key = () => secp.utils.randomSecretKey();
const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
const NOW = 1_800_000_000, DAY = 86400;
const bh = (h: number) => bytesToHex(sha256(utf8ToBytes(`block-${h}`)));
const nb = (h: number): NotBefore => ({ height: h, hash: bh(h) });
function chain(tip: number | null): BlockHeaderSource & { setTip(t: number | null): void } {
  let t = tip;
  return { header: (h) => (t !== null && h <= t && h >= 0 ? { hash: bh(h) } : null), tip: () => t, setTip(x) { t = x; } };
}
/** Mock proof: JSON {d: digest, h: height, b: block hash}. A real verifier walks .ots operations; this one just reads. */
const mockVerifier: OtsProofVerifier = { verify(p, d) { try { const x = JSON.parse(p); return x.d === d ? { height: x.h, block_hash: x.b } : null; } catch { return null; } } };
const proof = (d: string, h: number, b = bh(h)) => JSON.stringify({ d, h, b });
function ctx(tip: number | null, freshK?: number | string) {
  const headers = chain(tip);
  const c: OtsContext & { anchor(hash: string, h: number): void; H: ReturnType<typeof chain> } = {
    proofs: {}, verifier: mockVerifier, headers, freshK, H: headers,
    anchor(hash, h) { (this.proofs[hash] ??= []).push(proof(hash, h)); },
  };
  return c;
}

function rotated(nbBase = 100) {
  const sks = [key(), key(), key()], R1 = key(), R2 = key();
  const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(R1), NOW - 2 * DAY, NOW + 5 * DAY, nb(nbBase));
  const s1 = makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(R1), NOW - DAY, NOW + 5 * DAY, nb(nbBase + 1));
  const st = newKeyState(s0.hash); addStatement(st, s0); addStatement(st, s1);
  return { sks, R1, R2, s0, s1, st };
}

describe("OTS rule 1: stamping (async, never blocks), upgrade, CONF", () => {
  beforeEach(async () => { await env.DB.exec("DELETE FROM km_key_ots"); await env.DB.exec("DELETE FROM km_key_records"); await env.DB.exec("DELETE FROM snapshot_heads"); });
  const cal = (o: Partial<{ fail: boolean; hang: boolean; upgraded: boolean }> = {}): OtsCalendar & { stamps: number; ups: number } => ({
    stamps: 0, ups: 0,
    async stamp(d) { this.stamps++; if (o.hang) return new Promise<string>(() => {}); if (o.fail) throw new Error("down"); return `pending:${d}`; },
    async upgrade(p) { this.ups++; return o.upgraded ? p.replace("pending:", "complete:") : null; },
  });
  it("stamps on every calendar that answers; a failing calendar just leaves fewer proofs; none -> unstamped, no throw", async () => {
    expect(await stampRecord(env.DB, "aa".repeat(32), [cal(), cal({ fail: true }), cal()], NOW)).toBe(2);
    expect(await stampRecord(env.DB, "bb".repeat(32), [cal({ fail: true })], NOW)).toBe(0);
    const rows = await env.DB.prepare("SELECT rec_hash, proofs_json, status FROM km_key_ots").all<{ rec_hash: string; proofs_json: string; status: string }>();
    expect(rows.results.map((r) => [r.rec_hash.slice(0, 2), JSON.parse(r.proofs_json).length, r.status])).toEqual([["aa", 2, "pending"]]);
  });
  it("stamping never blocks storing/signing: a hanging calendar does not delay storeKeyRecord", async () => {
    const s = makeInception(key(), pk(key()), pk(key()), NOW, NOW + DAY);
    const hang = cal({ hang: true });
    const pending: Promise<unknown>[] = [];
    const out = await storeKeyRecord(env.DB, "statement", s, NOW, (h) => stampInBackground((p) => pending.push(p), env.DB, h, [hang], NOW));
    expect(out).toBe("accepted");
    expect(hang.stamps).toBe(1);
    expect(pending.length).toBe(1); // handed to waitUntil, not awaited
    const thrower = await storeKeyRecord(env.DB, "statement", makeInception(key(), pk(key()), pk(key()), NOW, NOW + DAY), NOW, () => { throw new Error("x"); });
    expect(thrower).toBe("accepted");
  });
  it("daily cron upgrades pending proofs once they are in a block (one pass)", async () => {
    await stampRecord(env.DB, "cc".repeat(32), [cal()], NOW);
    expect(await upgradeStamps(env.DB, [cal()], NOW)).toBe(0); // not in a block yet
    const c = cal({ upgraded: true });
    expect(await upgradeStamps(env.DB, [c], NOW)).toBe(1);
    const r = await env.DB.prepare("SELECT proofs_json, status FROM km_key_ots").first<{ proofs_json: string; status: string }>();
    expect(r!.status).toBe("upgraded"); expect(JSON.parse(r!.proofs_json)[0]).toMatch(/^complete:/);
  });
  it("an anchor counts only at >= CONF = 6 confirmations, with a matching header", () => {
    expect(CONF).toBe(6);
    const c = ctx(105); c.anchor("dd".repeat(32), 100);
    expect(anchorOf(c, "dd".repeat(32))).toBe(100);  // 105-100+1 = 6
    c.H.setTip(104); expect(anchorOf(c, "dd".repeat(32))).toBeNull(); // 5
    const bad = ctx(200); (bad.proofs["ee".repeat(32)] = [proof("ee".repeat(32), 100, "00".repeat(32))]);
    expect(anchorOf(bad, "ee".repeat(32))).toBeNull(); // block hash doesn't match the header
    const wrongDigest = ctx(200); wrongDigest.proofs["ff".repeat(32)] = [proof("11".repeat(32), 100)];
    expect(anchorOf(wrongDigest, "ff".repeat(32))).toBeNull();
  });
  it("cron with OTS on stamps the promoted handover and runs the upgrade pass; the head is not delayed", async () => {
    const t = Math.floor(Date.now() / 1000);
    const sks = [key(), key(), key()], rev = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(rev), t - DAY, t + 3 * DAY);
    await storeKeyRecord(env.DB, "statement", s0, t);
    await stageHandover(env.DB, makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), t, t + 3 * DAY), t);
    const c = cal({ hang: true }); const up = cal();
    const e = { ...env, KM_SIGNED_RESULTS: "on", KM_KEY_LIFECYCLE: "on", KM_KEY_OTS: "on", KM_KEY_ROOT: s0.hash, KM_RESULT_SK_NEXT_HEX: bytesToHex(sks[1]!) };
    const seq = await writeDailyHead(e as never, "v1", t, { calendars: [c, up], waitUntil: () => {} });
    expect(seq).toBe(0); // head written even though one calendar never answers
    expect(c.stamps).toBe(1);
  });
});

describe("OTS rule 2: notbefore + FRESH_K", () => {
  it("FRESH_K defaults to 36, env may set it, compiled max 144", () => {
    expect([FRESH_K_DEFAULT, FRESH_K_MAX]).toEqual([36, 144]);
    expect(effectiveFreshK(undefined)).toBe(36); expect(effectiveFreshK("10")).toBe(10);
    expect(effectiveFreshK("500")).toBe(144); expect(effectiveFreshK("x")).toBe(36); expect(effectiveFreshK(0)).toBe(36);
  });
  it("anchor more than FRESH_K blocks after notbefore -> stale; exactly FRESH_K -> fine", () => {
    const c = ctx(1000);
    c.anchor("a1".repeat(32), 136); expect(isStale(c, "a1".repeat(32), nb(100))).toBe(false);
    c.anchor("a2".repeat(32), 137); expect(isStale(c, "a2".repeat(32), nb(100))).toBe(true);
    expect(isStale({ ...c, freshK: "50" }, "a2".repeat(32), nb(100))).toBe(false);
    expect(isStale(c, "a3".repeat(32), { height: 100, hash: "00".repeat(32) })).toBe(true); // notbefore names no real block
    expect(isStale(c, "a4".repeat(32), nb(100))).toBe(false); // unanchored: not (yet) stale
  });
  it("attack: a handover stamped then held back is stale and never joins the lineage", () => {
    const sks = [key(), key(), key()], rev = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(rev), NOW - DAY, NOW + 5 * DAY, nb(100));
    const held = makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), NOW - DAY, NOW + 5 * DAY, nb(101)); // signed at block 101
    const st = newKeyState(s0.hash); addStatement(st, s0); addStatement(st, held);
    const c = ctx(400); c.anchor(s0.hash, 102); c.anchor(held.hash, 300);   // released ~200 blocks later
    expect(currentStatement(st, NOW, { ots: c })?.hash).toBe(s0.hash);
    expect(statementStatus(st, held.hash, NOW, { ots: c }).status).toBe("unknown");
    expect(currentStatement(st, NOW)?.hash).toBe(held.hash); // without OTS (flag off) behaviour is unchanged
  });
});

describe("OTS rule 3: order by heights only", () => {
  it("A strictly before B iff anchor(A) < notbefore(B); equal or overlapping = tie; timestamps ignored", () => {
    const c = ctx(1000); c.anchor("b1".repeat(32), 100);
    const A = { hash: "b1".repeat(32), notbefore: nb(95) };
    expect(strictlyBefore(c, A, { notbefore: nb(101) })).toBe(true);
    expect(strictlyBefore(c, A, { notbefore: nb(100) })).toBe(false);
    expect(strictlyBefore(c, A, { notbefore: nb(90) })).toBe(false);
    expect(strictlyBefore(c, { hash: "b9".repeat(32), notbefore: nb(95) }, { notbefore: nb(500) })).toBe(false); // unanchored
    expect(strictlyBefore(c, { hash: "b1".repeat(32) }, { notbefore: nb(500) })).toBe(false); // A unbounded (pre-OTS)
    expect(strictlyBefore(c, A, {})).toBe(false); // B unbounded
  });
});

describe("OTS rules 4 + 5: forks stay terminal, no anchor tiebreak, no salvage", () => {
  it("statement fork with anchors: still terminal; archive records anchor height as provenance only", () => {
    const { sks, R1, s0, s1, st } = rotated();
    const twin = makeHandover(s0, sks[0]!, sks[1]!, pk(key()), pk(R1), NOW - DAY, NOW + DAY, nb(101));
    addStatement(st, twin);
    const c = ctx(500); c.anchor(s0.hash, 101); c.anchor(s1.hash, 102); c.anchor(twin.hash, 130);
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("compromised");
    const head: HeadPayload = { type: "klickymart-head", v: 1, snapshot_id: "s", snapshot_digest: "d1".repeat(32), sequence: 1, created_at: NOW - 60, expires_at: NOW + 600, prev_head: null, key_statement_hash: s1.hash };
    const res = signResult(buildResult(null, "ee".repeat(32), "nonce-123", head, NOW - 10, s1.hash), bytesToHex(sks[1]!));
    const a = archiveResult(res, st, NOW, { ots: c });
    expect(a.status).toBe("signed_under_compromised_lineage");
    expect(a.key_statement_anchor_height).toEqual({ value: 102, provenance: "observed" });
    expect(verifyResultWithKeys(res, signHead(head, bytesToHex(sks[1]!)), st, { nonce: "nonce-123", nowS: NOW, highWater: 0, ots: c }).ok).toBe(false);
    expect("key_statement_anchor_height" in archiveResult(res, st, NOW)).toBe(false); // OTS off: field absent
  });
  it("conflicting rotations: terminal even when one is anchored far earlier", () => {
    const { sks, R1, s1, st } = rotated();
    const a = makeRevkeyRotate(s1, sks[1]!, R1, pk(key()), NOW, nb(110)), b = makeRevkeyRotate(s1, sks[1]!, R1, pk(key()), NOW, nb(111));
    addRevkeyRotate(st, a); addRevkeyRotate(st, b);
    const c = ctx(500); c.anchor(a.hash, 111); c.anchor(b.hash, 140);
    expect(evaluate(st, NOW, c).compromised).toMatch(/rotation fork/);
    expect(currentStatement(st, NOW, { ots: c })).toBeNull();
  });
});

describe("OTS rules 6 + 7: old revocation key R1 after R1 -> R2", () => {
  function setup() {
    const r = rotated();
    const rot = makeRevkeyRotate(r.s1, r.sks[1]!, r.R1, pk(r.R2), NOW, nb(200));
    addRevkeyRotate(r.st, rot);
    return { ...r, rot };
  }
  it("R1 revoke strictly before the rotation: valid and terminal (latched, survives export and dropping OTS)", () => {
    const { R1, s1, st, rot } = setup();
    const rv = makeRevoke(R1, s1.hash, NOW, nb(150));
    addRevoke(st, rv);
    const c = ctx(400); c.anchor(rv.hash, 160); c.anchor(rot.hash, 205);
    expect(judgeOldKeyRevoke(c, rv, rot)).toBe("valid");
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("revoked");
    const re = importKeyState(exportKeyState(st));
    expect(statementStatus(re, s1.hash, NOW).status).toBe("revoked");
  });
  it("attack: R1 revoke strictly after the rotation is ignored as stale", () => {
    const { R1, s1, st, rot } = setup();
    const rv = makeRevoke(R1, s1.hash, NOW, nb(260));
    addRevoke(st, rv);
    const c = ctx(400); c.anchor(rot.hash, 205); c.anchor(rv.hash, 262);
    expect(judgeOldKeyRevoke(c, rv, rot)).toBe("stale");
    expect(currentStatement(st, NOW, { ots: c })?.hash).toBe(s1.hash);
  });
  it("tie / overlapping windows (both confirmed, neither strictly first): the revoke wins", () => {
    const { R1, s1, st, rot } = setup();
    const rv = makeRevoke(R1, s1.hash, NOW, nb(198));
    addRevoke(st, rv);
    const c = ctx(400); c.anchor(rot.hash, 204); c.anchor(rv.hash, 203); // rv anchor 203 !< rot nb 200; rot anchor 204 !< rv nb 198
    expect(judgeOldKeyRevoke(c, rv, rot)).toBe("valid");
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("revoked");
  });
  it("attack: a backdated rotation cannot undo a revoke", () => {
    const { sks, R1, R2, s1 } = rotated();
    const st = rotated().st; void st;
    const r = rotated();
    const rv = makeRevoke(r.R1, r.s1.hash, NOW, nb(195));
    const backdated = makeRevkeyRotate(r.s1, r.sks[1]!, r.R1, pk(r.R2), NOW - 30 * DAY, nb(120)); // claims block 120, created_at a month ago
    addRevoke(r.st, rv); addRevkeyRotate(r.st, backdated);
    const c = ctx(400); c.anchor(rv.hash, 196); c.anchor(backdated.hash, 210);
    expect(isStale(c, backdated.hash, backdated.payload.notbefore)).toBe(true); // 210 - 120 > 36
    expect(statementStatus(r.st, r.s1.hash, NOW, { ots: c }).status).toBe("revoked"); // rotation dropped; R1 is current; revoke stands
    // a backdated rotation that is NOT stale (nb within K of its anchor) still isn't strictly before the revoke
    const r2 = rotated();
    const rv2 = makeRevoke(r2.R1, r2.s1.hash, NOW, nb(195));
    const rot2 = makeRevkeyRotate(r2.s1, r2.sks[1]!, r2.R1, pk(r2.R2), NOW - 30 * DAY, nb(180));
    addRevoke(r2.st, rv2); addRevkeyRotate(r2.st, rot2);
    const c2 = ctx(400); c2.anchor(rv2.hash, 196); c2.anchor(rot2.hash, 210);
    expect(judgeOldKeyRevoke(c2, rv2, rot2)).toBe("valid"); // tie -> revoke wins
    expect(statementStatus(r2.st, r2.s1.hash, NOW, { ots: c2 }).status).toBe("revoked");
    void sks; void R1; void R2; void s1;
  });
  it("rule 7: unconfirmed -> results fail closed while pending; resolves on confirmation", () => {
    const { R1, s1, st, rot } = setup();
    const rv = makeRevoke(R1, s1.hash, NOW, nb(201));
    addRevoke(st, rv);
    const c = ctx(203); c.anchor(rot.hash, 202); c.anchor(rv.hash, 202); // both 2 confirmations: < CONF
    expect(judgeOldKeyRevoke(c, rv, rot)).toBe("pending");
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("disputed");
    expect(currentStatement(st, NOW, { ots: c })).toBeNull();
    c.H.setTip(210); // both confirmed, tie -> revoke wins, terminal
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("revoked");
    c.H.setTip(211); delete c.proofs[rv.hash];
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("revoked"); // valid revoke stays terminal forever
  });
  it("rule 7: after FRESH_K + CONF blocks past the newest notbefore an unanchored revoke is stale and the lineage resumes", () => {
    const { R1, s1, st, rot } = setup();
    const rv = makeRevoke(R1, s1.hash, NOW, nb(201));
    addRevoke(st, rv);
    const c = ctx(201 + 36 + 6 - 1); c.anchor(rot.hash, 202);
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("disputed");
    c.H.setTip(201 + 36 + 6);
    expect(judgeOldKeyRevoke(c, rv, rot)).toBe("stale");
    expect(currentStatement(st, NOW, { ots: c })?.hash).toBe(s1.hash);
  });
  it("rule 7: an anchored revoke vs an unanchored rotation past the deadline -> the revoke stands", () => {
    const { R1, s1, st, rot } = setup();
    const rv = makeRevoke(R1, s1.hash, NOW, nb(201));
    addRevoke(st, rv);
    const c = ctx(300); c.anchor(rv.hash, 203);
    expect(judgeOldKeyRevoke(c, rv, rot)).toBe("valid");
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("revoked");
  });
});

describe("OTS rule 8: headers injected; none = unconfirmed, fail closed only in a dispute", () => {
  it("no headers: a dispute fails closed; normal operation is untouched", () => {
    const { R1, R2, sks, s1, st } = rotated();
    const noHeaders: OtsContext = { proofs: {}, verifier: mockVerifier, headers: null };
    expect(currentStatement(st, NOW, { ots: noHeaders })?.hash).toBe(s1.hash); // no dispute: fine
    const rot = makeRevkeyRotate(s1, sks[1]!, R1, pk(R2), NOW, nb(200)); addRevkeyRotate(st, rot);
    const rv = makeRevoke(R1, s1.hash, NOW, nb(150)); addRevoke(st, rv);
    noHeaders.proofs[rv.hash] = [proof(rv.hash, 151)]; noHeaders.proofs[rot.hash] = [proof(rot.hash, 205)];
    expect(statementStatus(st, s1.hash, NOW, { ots: noHeaders }).status).toBe("disputed");
  });
  it("several header sources: a header counts only if all answering sources agree; tip = lowest", () => {
    const a = chain(300), b = chain(250);
    const liar: BlockHeaderSource = { header: (h) => ({ hash: h === 100 ? "00".repeat(32) : bh(h) }), tip: () => 400 };
    const both = combineHeaderSources([a, b]);
    expect(both.header(100)?.hash).toBe(bh(100)); expect(both.tip()).toBe(250);
    expect(combineHeaderSources([a, liar]).header(100)).toBeNull();
    expect(combineHeaderSources([]).tip()).toBeNull();
    const c: OtsContext = { proofs: { ["c1".repeat(32)]: [proof("c1".repeat(32), 100)] }, verifier: mockVerifier, headers: combineHeaderSources([a, liar]) };
    expect(anchorOf(c, "c1".repeat(32))).toBeNull();
  });
});

describe("KM_KEY_OTS off: behaviour exactly as before", () => {
  beforeEach(async () => { await env.DB.exec("DELETE FROM km_key_ots"); await env.DB.exec("DELETE FROM km_key_records"); await env.DB.exec("DELETE FROM snapshot_heads"); });
  it("switch off by default and in shipped vars", () => {
    expect(otsEnabled({})).toBe(false); expect(otsEnabled({ KM_KEY_OTS: "off" })).toBe(false); expect(otsEnabled({ KM_KEY_OTS: "on" })).toBe(true);
    expect(otsEnabled(env as never)).toBe(false);
  });
  it("records made without notbefore are byte-identical to pre-OTS records (no field, same hash shape)", () => {
    const sk = key(), n = key(), r = key();
    const s: KeyStatement = makeInception(sk, pk(n), pk(r), NOW, NOW + DAY);
    expect("notbefore" in s.payload).toBe(false);
    expect(Object.keys(makeRevoke(r, s.hash, NOW).payload).sort()).toEqual(["created_at", "revocation_key", "target", "type", "v"]);
    expect("otsValidRevokes" in JSON.parse(exportKeyState(newKeyState(s.hash)))).toBe(false);
  });
  it("cron with KM_KEY_OTS off never calls a calendar and writes no proofs; /open-store/keys has no ots fields", async () => {
    const t = Math.floor(Date.now() / 1000);
    const sks = [key(), key(), key()], rev = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(rev), t - DAY, t + 3 * DAY);
    await storeKeyRecord(env.DB, "statement", s0, t);
    await stageHandover(env.DB, makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), t, t + 3 * DAY), t);
    let calls = 0;
    const spy: OtsCalendar = { async stamp() { calls++; return "p"; }, async upgrade() { calls++; return null; } };
    const e = { ...env, KM_SIGNED_RESULTS: "on", KM_KEY_LIFECYCLE: "on", KM_KEY_ROOT: s0.hash, KM_RESULT_SK_NEXT_HEX: bytesToHex(sks[1]!) };
    expect(await writeDailyHead(e as never, "v1", t, { calendars: [spy] })).toBe(0);
    expect(calls).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM km_key_ots").first<{ n: number }>())!.n).toBe(0);
    const keys = JSON.parse(await (await openStoreRoute("/open-store/keys", new URL("https://x/open-store/keys"), e as never)).text());
    expect("ots_proofs" in keys || "ots_params" in keys).toBe(false);
    const on = JSON.parse(await (await openStoreRoute("/open-store/keys", new URL("https://x/open-store/keys"), { ...e, KM_KEY_OTS: "on" } as never)).text());
    expect(on.ots_params).toEqual({ conf: 6, fresh_k: 36 });
  });
});

// ---------------- Satoshi OTS answers 1-4 ----------------
import { otsActivation, otsCheck } from "../src/key-ots";

function holed(tip: number, hole: Set<number>): BlockHeaderSource & { setTip(t: number): void; fill(): void } {
  let t = tip; const h = hole;
  return { header: (x) => (x <= t && x >= 0 && !h.has(x) ? { hash: bh(x) } : null), tip: () => t, setTip(v) { t = v; }, fill() { h.clear(); } };
}

describe("answer 1: FRESH_K compiled max 144 (confirmed)", () => {
  it("max is 144 and env cannot exceed it", () => { expect(FRESH_K_MAX).toBe(144); expect(effectiveFreshK("145")).toBe(144); expect(effectiveFreshK("144")).toBe(144); });
});

describe("answer 2: current-key revokes are exempt from staleness", () => {
  it("a current-key revoke anchored far too late still revokes; stale old-key revokes, rotations and statements don't count", () => {
    const { R1, s1, st } = rotated();
    const late = makeRevoke(R1, s1.hash, NOW, nb(150));
    addRevoke(st, late);
    const c = ctx(800); c.anchor(late.hash, 600); // 450 blocks late
    expect(otsCheck(c, late.hash, late.payload.notbefore)).toBe("stale");
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("revoked");
  });
  it("an old-key revoke anchored too late is ignored", () => {
    const r = rotated();
    const rot = makeRevkeyRotate(r.s1, r.sks[1]!, r.R1, pk(r.R2), NOW, nb(140)); addRevkeyRotate(r.st, rot);
    const rv = makeRevoke(r.R1, r.s1.hash, NOW, nb(130)); addRevoke(r.st, rv);
    const c = ctx(800); c.anchor(rot.hash, 145); c.anchor(rv.hash, 400);
    expect(currentStatement(r.st, NOW, { ots: c })?.hash).toBe(r.s1.hash);
  });
});

describe("answer 3: pre-OTS records are unbounded; activation; notbefore required after", () => {
  function preOts() {
    const sks = [key(), key(), key(), key()], R1 = key(), R2 = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(R1), NOW - 2 * DAY, NOW + 5 * DAY); // no notbefore
    const s1 = makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(R1), NOW - DAY, NOW + 5 * DAY); // no notbefore
    const st = newKeyState(s0.hash); addStatement(st, s0); addStatement(st, s1);
    return { sks, R1, R2, s0, s1, st };
  }
  it("pre-OTS statements stay valid chain history under an OTS context, even when anchored", () => {
    const { s1, st, s0 } = preOts();
    const c = ctx(900); c.anchor(s0.hash, 300); c.anchor(s1.hash, 500);
    expect(otsCheck(c, s1.hash, undefined)).toBe("ok");
    expect(currentStatement(st, NOW, { ots: c })?.hash).toBe(s1.hash);
  });
  it("a pre-OTS rotation vs an R1 revoke: never ordered -> tie -> the revoke wins", () => {
    const { sks, R1, R2, s1, st } = preOts();
    const rot = makeRevkeyRotate(s1, sks[1]!, R1, pk(R2), NOW); addRevkeyRotate(st, rot); // unbounded
    const rv = makeRevoke(R1, s1.hash, NOW, nb(500)); addRevoke(st, rv);
    const c = ctx(900); c.anchor(rot.hash, 100); c.anchor(rv.hash, 501); // rotation anchored much earlier: still no order
    expect(judgeOldKeyRevoke(c, rv, rot)).toBe("valid");
    expect(statementStatus(st, s1.hash, NOW, { ots: c }).status).toBe("revoked");
  });
  it("after activation (first statement with notbefore) a later statement or rotation without notbefore is rejected", () => {
    const { sks, R1, R2, s1, st } = preOts();
    const act = makeHandover(s1, sks[1]!, sks[2]!, pk(sks[3]!), pk(R1), NOW, NOW + 5 * DAY, nb(500)); addStatement(st, act);
    const noNb = makeHandover(act, sks[2]!, sks[3]!, pk(key()), pk(R1), NOW + 10, NOW + 5 * DAY); addStatement(st, noNb);
    const c = ctx(900);
    expect(currentStatement(st, NOW + 20, { ots: c })?.hash).toBe(act.hash);
    const rotNoNb = makeRevkeyRotate(act, sks[2]!, R1, pk(R2), NOW); addRevkeyRotate(st, rotNoNb);
    const rv = makeRevoke(R2, act.hash, NOW, nb(600)); addRevoke(st, rv); // would only count if the rotation were accepted
    expect(statementStatus(st, act.hash, NOW + 20, { ots: c }).status).toBe("current");
  });
  it("after activation an old-key revoke without notbefore is rejected", () => {
    const { sks, R1, R2, s1, st } = preOts();
    const act = makeHandover(s1, sks[1]!, sks[2]!, pk(sks[3]!), pk(R1), NOW, NOW + 5 * DAY, nb(500)); addStatement(st, act);
    const rot = makeRevkeyRotate(act, sks[2]!, R1, pk(R2), NOW, nb(510)); addRevkeyRotate(st, rot);
    addRevoke(st, makeRevoke(R1, act.hash, NOW));
    const c = ctx(900); c.anchor(rot.hash, 512);
    expect(currentStatement(st, NOW + 20, { ots: c })?.hash).toBe(act.hash);
  });
  it("Worker: activation happens only in the cron run that promotes a statement with notbefore; afterwards records need notbefore", async () => {
    await env.DB.exec("DELETE FROM km_key_ots_state"); await env.DB.exec("DELETE FROM km_key_records"); await env.DB.exec("DELETE FROM km_key_ots"); await env.DB.exec("DELETE FROM snapshot_heads");
    const t = Math.floor(Date.now() / 1000);
    const sks = [key(), key(), key(), key()], rev = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(rev), t - DAY, t + 3 * DAY);
    await storeKeyRecord(env.DB, "statement", s0, t);
    const cal: OtsCalendar = { async stamp(d) { return `p:${d}`; }, async upgrade() { return null; } };
    const base = { ...env, KM_SIGNED_RESULTS: "on", KM_KEY_LIFECYCLE: "on", KM_KEY_OTS: "on", KM_KEY_ROOT: s0.hash };
    // a staged handover WITHOUT notbefore: promoted, but OTS does not activate
    const h1 = makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), t, t + 3 * DAY);
    await stageHandover(env.DB, h1, t);
    await writeDailyHead({ ...base, KM_RESULT_SK_NEXT_HEX: bytesToHex(sks[1]!) } as never, "v1", t, { calendars: [cal] });
    expect(await otsActivation(env.DB)).toBeNull();
    expect(await storeKeyRecord(env.DB, "revoke", makeRevoke(rev, "77".repeat(32), t), t)).toBe("accepted"); // still allowed
    // a fresh statement WITH notbefore promoted in this cron run activates OTS and is stamped
    const h2 = makeHandover(h1, sks[1]!, sks[2]!, pk(sks[3]!), pk(rev), t + 1, t + 3 * DAY, nb(900));
    await stageHandover(env.DB, h2, t);
    const pend: Promise<unknown>[] = [];
    await writeDailyHead({ ...base, KM_RESULT_SK_NEXT_HEX: bytesToHex(sks[2]!) } as never, "v2", t + 2, { calendars: [cal], waitUntil: (p) => pend.push(p) });
    await Promise.all(pend);
    expect((await otsActivation(env.DB))?.stmt).toBe(h2.hash);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM km_key_ots WHERE rec_hash = ?").bind(h2.hash).first<{ n: number }>())!.n).toBe(1);
    expect(await storeKeyRecord(env.DB, "revoke", makeRevoke(rev, "78".repeat(32), t), t)).toBe("rejected");
    expect(await storeKeyRecord(env.DB, "revoke", makeRevoke(rev, "78".repeat(32), t, nb(901)), t)).toBe("accepted");
  });
  it("Worker: with KM_KEY_OTS off nothing activates even when a notbefore statement is promoted", async () => {
    await env.DB.exec("DELETE FROM km_key_ots_state"); await env.DB.exec("DELETE FROM km_key_records"); await env.DB.exec("DELETE FROM snapshot_heads");
    const t = Math.floor(Date.now() / 1000);
    const sks = [key(), key(), key()], rev = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(rev), t - DAY, t + 3 * DAY);
    await storeKeyRecord(env.DB, "statement", s0, t);
    await stageHandover(env.DB, makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), t, t + 3 * DAY, nb(900)), t);
    await writeDailyHead({ ...env, KM_SIGNED_RESULTS: "on", KM_KEY_LIFECYCLE: "on", KM_KEY_ROOT: s0.hash, KM_RESULT_SK_NEXT_HEX: bytesToHex(sks[1]!) } as never, "v1", t);
    expect(await otsActivation(env.DB)).toBeNull();
  });
});

describe("answer 4: header eclipse cap (first_seen_tip) and outright rejects", () => {
  it("reject outright: notbefore hash disagrees with a known header, or height > CONF above the tip", () => {
    const c = ctx(500);
    expect(otsCheck(c, "e1".repeat(32), { height: 400, hash: "00".repeat(32) })).toBe("reject");
    expect(otsCheck(c, "e2".repeat(32), nb(507))).toBe("reject"); // 507 > 500 + 6
    expect(otsCheck(c, "e3".repeat(32), nb(506))).toBe("ok");     // unknown yet, not too far
    const { sks, R1, R2, s1, st } = rotated();
    const futRot = makeRevkeyRotate(s1, sks[1]!, R1, pk(R2), NOW, nb(9999)); addRevkeyRotate(st, futRot);
    addRevoke(st, makeRevoke(R2, s1.hash, NOW, nb(400)));
    expect(currentStatement(st, NOW, { ots: c })?.hash).toBe(s1.hash); // rotation rejected -> R2 isn't current -> its revoke doesn't count
  });
  it("an eclipsed rotation becomes invalid after first_seen_tip + FRESH_K + CONF; before that it stands", () => {
    const r = rotated();
    const rot = makeRevkeyRotate(r.s1, r.sks[1]!, r.R1, pk(r.R2), NOW, nb(300)); addRevkeyRotate(r.st, rot);
    const H = holed(302, new Set([300]));
    const c: OtsContext = { proofs: {}, verifier: mockVerifier, headers: H };
    expect(otsCheck(c, rot.hash, rot.payload.notbefore, 302)).toBe("ok");
    addRevoke(r.st, makeRevoke(r.R2, r.s1.hash, NOW, nb(301)));
    expect(statementStatus(r.st, r.s1.hash, NOW, { ots: c }).status).toBe("revoked"); // first seen at 302; R2 is current
    const r2 = rotated();
    const rot2 = makeRevkeyRotate(r2.s1, r2.sks[1]!, r2.R1, pk(r2.R2), NOW, nb(300)); addRevkeyRotate(r2.st, rot2);
    const H2 = holed(302, new Set([300]));
    const c2: OtsContext = { proofs: {}, verifier: mockVerifier, headers: H2 };
    evaluate(r2.st, NOW, c2); // first seen at tip 302
    H2.setTip(302 + 36 + 6);
    expect(otsCheck(c2, rot2.hash, rot2.payload.notbefore, r2.st.otsFirstSeenTip![rot2.hash])).toBe("eclipsed");
    addRevoke(r2.st, makeRevoke(r2.R1, r2.s1.hash, NOW, nb(301))); // R1 is current again
    expect(statementStatus(r2.st, r2.s1.hash, NOW, { ots: c2 }).status).toBe("revoked");
  });
  it("an eclipsed key statement is invalid after the cap", () => {
    const sks = [key(), key(), key()], rev = key();
    const s0 = makeInception(sks[0]!, pk(sks[1]!), pk(rev), NOW - DAY, NOW + 5 * DAY, nb(100));
    const s1 = makeHandover(s0, sks[0]!, sks[1]!, pk(sks[2]!), pk(rev), NOW - 10, NOW + 5 * DAY, nb(300));
    const st = newKeyState(s0.hash); addStatement(st, s0); addStatement(st, s1);
    const H = holed(302, new Set([300])); const c: OtsContext = { proofs: {}, verifier: mockVerifier, headers: H };
    expect(currentStatement(st, NOW, { ots: c })?.hash).toBe(s1.hash);
    H.setTip(302 + 42);
    expect(currentStatement(st, NOW, { ots: c })?.hash).toBe(s0.hash);
  });
  it("an eclipse never turns a valid revoke into an ignored one", () => {
    // (a) old-key revoke whose notbefore is eclipsed: tie -> revoke wins (terminal)
    const r = rotated();
    const rot = makeRevkeyRotate(r.s1, r.sks[1]!, r.R1, pk(r.R2), NOW, nb(200)); addRevkeyRotate(r.st, rot);
    const rv = makeRevoke(r.R1, r.s1.hash, NOW, nb(250)); addRevoke(r.st, rv);
    const H = holed(252, new Set([250])); const c: OtsContext = { proofs: { [rot.hash]: [proof(rot.hash, 201)] }, verifier: mockVerifier, headers: H };
    expect(statementStatus(r.st, r.s1.hash, NOW, { ots: c }).status).toBe("disputed"); // delayed, fail closed
    H.setTip(252 + 42);
    expect(statementStatus(r.st, r.s1.hash, NOW, { ots: c }).status).toBe("revoked");
    // (b) a revoke already judged valid stays valid when headers later vanish entirely
    const r2 = rotated();
    const rot2 = makeRevkeyRotate(r2.s1, r2.sks[1]!, r2.R1, pk(r2.R2), NOW, nb(200)); addRevkeyRotate(r2.st, rot2);
    const rv2 = makeRevoke(r2.R1, r2.s1.hash, NOW, nb(150)); addRevoke(r2.st, rv2);
    const good = ctx(400); good.anchor(rv2.hash, 151); good.anchor(rot2.hash, 205);
    expect(statementStatus(r2.st, r2.s1.hash, NOW, { ots: good }).status).toBe("revoked");
    const eclipse: OtsContext = { proofs: good.proofs, verifier: mockVerifier, headers: holed(400, new Set(Array.from({ length: 401 }, (_, i) => i))) };
    expect(statementStatus(r2.st, r2.s1.hash, NOW, { ots: eclipse }).status).toBe("revoked");
    expect(statementStatus(r2.st, r2.s1.hash, NOW, { ots: { ...eclipse, headers: null } }).status).toBe("revoked");
    // (c) a current-key revoke under a total eclipse still revokes
    const r3 = rotated();
    addRevoke(r3.st, makeRevoke(r3.R1, r3.s1.hash, NOW, nb(150)));
    const c3: OtsContext = { proofs: {}, verifier: mockVerifier, headers: holed(400, new Set([150])) };
    evaluate(r3.st, NOW, c3); (c3.headers as ReturnType<typeof holed>).setTip(1000);
    expect(statementStatus(r3.st, r3.s1.hash, NOW, { ots: c3 }).status).toBe("revoked");
    // (d) a total eclipse past the cap invalidates the eclipsed statements themselves: nothing is current (fail closed)
    const all: OtsContext = { proofs: {}, verifier: mockVerifier, headers: holed(400, new Set(Array.from({ length: 401 }, (_, i) => i))) };
    evaluate(r3.st, NOW, all); (all.headers as ReturnType<typeof holed>).setTip(1000);
    expect(currentStatement(r3.st, NOW, { ots: all })).toBeNull();
  });
  it("first_seen_tip is latched and survives export/import (earliest wins)", () => {
    const { st, s1 } = rotated();
    const H = holed(300, new Set()); evaluate(st, NOW, { proofs: {}, verifier: mockVerifier, headers: H });
    H.setTip(900); evaluate(st, NOW, { proofs: {}, verifier: mockVerifier, headers: H });
    expect(st.otsFirstSeenTip![s1.hash]).toBe(300);
    expect(importKeyState(exportKeyState(st)).otsFirstSeenTip![s1.hash]).toBe(300);
  });
});
