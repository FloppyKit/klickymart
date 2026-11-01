import { describe, expect, it } from "vitest";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { checkThreads, validateHandshakeEvent, parseMsat, type NostrEventLine } from "../src/handshake";
import * as handshake from "../src/handshake";

// Synthetic keys generated per test run only; never persisted or printed.
type Key = { sk: Uint8Array; pk: string };
const key = (): Key => { const sk = secp.utils.randomSecretKey(); return { sk, pk: bytesToHex(secp.schnorr.getPublicKey(sk)) }; };
let t0 = 1793400000;
function sign(k: Key, kind: number, tags: string[][], content = ""): NostrEventLine {
  const ev = { pubkey: k.pk, created_at: t0++, kind, tags, content };
  const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), k.sk)) };
}
const need = (k: Key, extra: string[][] = []) => sign(k, 420, [["t", "commerce"], ["amount", "40000000", "msat"], ["payment", "zap"], ...extra], "need 2 cables");
const ful = (k: Key, n: NostrEventLine, extra: string[][] = []) => sign(k, 421, [["e", n.id, "", "need"], ["p", n.pubkey], ["proof", "tracking", "ups", "1Z999"], ...extra], "shipped");
const acc = (k: Key, f: NostrEventLine, needId: string, extra: string[][] = []) => sign(k, 422, [["e", f.id, "", "fulfillment"], ["e", needId, "", "need"], ["p", f.pubkey], ...extra], "thanks");
const marks = (r: ReturnType<typeof checkThreads>, id: string) => r.byId.get(id)!.marks;

describe("handshake: single-event validation", () => {
  const alice = key(), bob = key();
  it("accepts a valid 420/421/422", () => {
    const n = need(alice), f = ful(bob, n, [["amount", "40000000"]]), a = acc(alice, f, n.id, [["amount", "41000000"], ["tip", "1000000"], ["preimage", "ab".repeat(32)]]);
    for (const e of [n, f, a]) expect(validateHandshakeEvent(e).errors).toEqual([]);
    const p = validateHandshakeEvent(a).parsed!; expect(p.kind).toBe(422);
    if (p.kind === 422) { expect(p.amountMsat).toBe(41000000n); expect(p.tipMsat).toBe(1000000n); }
  });
  it("rejects bad signature / tampered content", () => {
    const n = need(alice); expect(validateHandshakeEvent({ ...n, content: "changed" }).ok).toBe(false);
  });
  it("rejects malformed amounts", () => {
    for (const v of ["-1", "1.5", "01", "1e9", "", "abc", "99999999999999999999"]) expect(parseMsat(v)).toBeNull();
    expect(parseMsat("0")).toBe(0n);
    expect(validateHandshakeEvent(sign(alice, 420, [["amount", "1.5"]])).ok).toBe(false);
  });
  it("421 needs exactly one need e-tag and one p", () => {
    const n = need(alice);
    expect(validateHandshakeEvent(sign(bob, 421, [["p", alice.pk]], "x")).ok).toBe(false);
    expect(validateHandshakeEvent(sign(bob, 421, [["e", n.id, "", "need"]], "x")).ok).toBe(false);
    expect(validateHandshakeEvent(sign(bob, 421, [["e", n.id, "", "need"], ["p", alice.pk], ["proof", "telepathy", "x"]])).ok).toBe(false);
  });
  it("422 tip must not exceed amount and needs amount", () => {
    const n = need(alice), f = ful(bob, n);
    expect(validateHandshakeEvent(acc(alice, f, n.id, [["amount", "5"], ["tip", "6"]])).errors).toContain("422: tip exceeds amount");
    expect(validateHandshakeEvent(acc(alice, f, n.id, [["tip", "6"]])).ok).toBe(false);
  });
  it("422 on a need must also cite the fulfillment; review-422 needs a store", () => {
    expect(validateHandshakeEvent(sign(alice, 422, [["e", "aa".repeat(32), "", "need"], ["p", bob.pk]])).ok).toBe(false);
    expect(validateHandshakeEvent(sign(alice, 422, [["rating", "4", "5"]])).ok).toBe(false);
    expect(validateHandshakeEvent(sign(alice, 422, [["r", "example.com"], ["rating", "4", "5"]])).ok).toBe(true);
  });
  it("420 must not reference a need", () => {
    expect(validateHandshakeEvent(sign(alice, 420, [["e", "aa".repeat(32), "", "need"]])).ok).toBe(false);
  });
});

describe("handshake: threading 420 -> 421 -> 422", () => {
  it("a clean loop is reported with no adverse marks", () => {
    const alice = key(), bob = key();
    const n = need(alice), f = ful(bob, n, [["amount", "40000000"]]), a = acc(alice, f, n.id, [["amount", "40000000"], ["zap", "cd".repeat(32)]]);
    const r = checkThreads([a, f, n]);
    expect(r.loops).toEqual([{ need: n.id, fulfillment: f.id, acceptance: a.id }]);
    expect(marks(r, f.id)).toEqual([]);
    expect(marks(r, a.id)).toEqual(["payment_claimed_unverified"]); // claimed, never "verified"
  });
  it("orphans are marked", () => {
    const alice = key(), bob = key(); const n = need(alice), f = ful(bob, n);
    expect(marks(checkThreads([f]), f.id)).toContain("orphan");
  });
  it("directed need: other fulfillers are marked not_directed", () => {
    const alice = key(), bob = key(), carol = key();
    const n = need(alice, [["p", bob.pk]]), f = ful(carol, n);
    expect(marks(checkThreads([n, f]), f.id)).toContain("not_directed");
  });
});

describe("handshake: adversarial (one operator, ten keys)", () => {
  const ten = Array.from({ length: 10 }, key);
  it("self-421 on own 420 is marked self_fulfillment", () => {
    const n = need(ten[0]), f = ful(ten[0], n), a = acc(ten[0], f, n.id, [["amount", "40000000"], ["preimage", "11".repeat(32)]]);
    const r = checkThreads([n, f, a]);
    expect(marks(r, f.id)).toContain("self_fulfillment");
    expect(marks(r, a.id)).toContain("payment_claimed_unverified");
  });
  it("cross-key self-dealing is structurally valid and is NOT marked verified (detection is out of scope; open question)", () => {
    const evs: NostrEventLine[] = [];
    for (let i = 0; i < 5; i++) { const n = need(ten[i]), f = ful(ten[i + 5], n), a = acc(ten[i], f, n.id, [["amount", "40000000"], ["preimage", String(i).repeat(64)]]); evs.push(n, f, a); }
    const r = checkThreads(evs);
    expect(r.loops.length).toBe(5);
    for (const [, e] of r.byId) expect(e.marks as string[]).not.toContain("verified");
  });
  it("422 on a 421 that references a different 420 is marked need_mismatch and not a loop", () => {
    const [op, helper] = ten; const n1 = need(op), n2 = need(op), f = ful(helper, n2);
    const a = acc(op, f, n1.id, [["amount", "40000000"]]);
    const r = checkThreads([n1, n2, f, a]);
    expect(marks(r, a.id)).toContain("need_mismatch");
    expect(r.loops).toEqual([]);
  });
  it("422 by someone other than the requester is marked acceptor_not_requester", () => {
    const n = need(ten[1]), f = ful(ten[2], n), a = acc(ten[3], f, n.id);
    const r = checkThreads([n, f, a]);
    expect(marks(r, a.id)).toContain("acceptor_not_requester"); expect(r.loops).toEqual([]);
  });
  it("replayed duplicates are counted once", () => {
    const n = need(ten[4]), f = ful(ten[5], n), a = acc(ten[4], f, n.id);
    const r = checkThreads([n, f, a, a, a, f]);
    expect(r.duplicates.length).toBe(3); expect(r.loops.length).toBe(1);
    expect(marks(r, a.id)).toContain("duplicate");
  });
  it("a second, distinct 422 for the same 421 is marked multiple_acceptances", () => {
    const n = need(ten[6]), f = ful(ten[7], n), a1 = acc(ten[6], f, n.id), a2 = acc(ten[6], f, n.id, [["amount", "1"]]);
    const r = checkThreads([n, f, a1, a2]);
    expect(marks(r, a1.id)).toContain("multiple_acceptances"); expect(marks(r, a2.id)).toContain("multiple_acceptances");
  });
  it("amount mismatches are marked", () => {
    const n = need(ten[8]), f = ful(ten[9], n, [["amount", "50000000"]]), a = acc(ten[8], f, n.id, [["amount", "30000000"], ["tip", "1000"]]);
    const r = checkThreads([n, f, a]);
    expect(marks(r, f.id)).toContain("owed_exceeds_offer"); expect(marks(r, a.id)).toContain("paid_below_owed");
    const n0 = sign(ten[8], 420, [], "no offer"), f0 = ful(ten[9], n0, [["amount", "5"]]);
    expect(marks(checkThreads([n0, f0]), f0.id)).toContain("owed_without_offer");
  });
  it("421 whose p tag is not the 420 author is marked requester_mismatch; wrong fulfiller p on 422 marked", () => {
    const n = need(ten[0]), f = sign(ten[1], 421, [["e", n.id, "", "need"], ["p", ten[2].pk]], "x");
    const a = sign(ten[0], 422, [["e", f.id, "", "fulfillment"], ["e", n.id, "", "need"], ["p", ten[3].pk]]);
    const r = checkThreads([n, f, a]);
    expect(marks(r, f.id)).toContain("requester_mismatch"); expect(marks(r, a.id)).toContain("fulfiller_mismatch");
  });
});

describe("handshake: validation only marks", () => {
  it("module exports no scoring/ranking surface and reports carry no numeric weight", () => {
    expect(Object.keys(handshake).filter((k) => /score|rank|weight|trust/i.test(k))).toEqual([]);
    const a = key(), b = key(); const n = need(a), f = ful(b, n), x = acc(a, f, n.id, [["amount", "40000000"], ["tip", "39000000"]]);
    const r = checkThreads([n, f, x]);
    for (const [, e] of r.byId) expect(Object.keys(e).sort()).toEqual(["marks", "result"]);
    // a big tip changes no mark relative to no tip
    const y = acc(a, f, n.id, [["amount", "40000000"]]);
    expect(marks(r, x.id)).toEqual(marks(checkThreads([n, f, y]), y.id));
  });
  it("is not imported by ranking code", async () => {
    const files = (import.meta as unknown as { glob: (p: string, o: object) => unknown }).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const importers = Object.entries(files).filter(([p, s]) => !p.endsWith("handshake.ts") && /from "\.\/handshake"/.test(s)).map(([p]) => p);
    expect(importers).toEqual([]);
  });
});
