import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { NOSTR_KIND_ENDPOINT_BINDING as K } from "../src/nostr-kinds";
import { applyBinding, bindingStatus, hashHex, bindingsEnabled, BINDING_D, canonicalJson, loadBindingState, matchEndpoint, type BEv, type BindingState } from "../src/endpoint-binding";
import { buildResult, paymentGate, recordSnapshotHead, latestHead, signHead, signResult, signedResultsEnabled, typedFields, verifyResult, type HeadPayload, type ResultPayload, type Signed } from "../src/signed-result";
import { openStoreRoute } from "../src/open-store";
import { buildFilters, ingestEvents, type IngestCtx } from "../src/relay-ingest";
import { handleRequest } from "../src/router";

// Synthetic keys only, generated per run. Nothing here touches a relay.
const key = () => secp.utils.randomSecretKey();
const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
const NOW = 1_800_000_000;
const NODE = "02" + "ab".repeat(32), NODE2 = "03" + "cd".repeat(32);
function ev(sk: Uint8Array, content: unknown, created_at = NOW - 100, opts: { kind?: number; d?: string; raw?: string } = {}): BEv {
  const base = { pubkey: pk(sk), created_at, kind: opts.kind ?? K, tags: [["d", opts.d ?? BINDING_D]], content: opts.raw ?? canonicalJson(content) };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const bind = (version: number, endpoints: Record<string, unknown> = { node_id: NODE }, expires_at = NOW + 86400) => ({ version, expires_at, endpoints });
function run(evs: BEv[], now = NOW): { s: BindingState | undefined; outs: string[] } {
  let s: BindingState | undefined; const outs: string[] = [];
  for (const e of evs) { const r = applyBinding(s, e, now); s = r.state; outs.push(r.outcome); }
  return { s, outs };
}

describe("endpoint bindings (v9.2 §2 acceptance)", () => {
  const sk = key();
  it("accepts a first state and a clean upgrade (version AND created_at up)", () => {
    const { s, outs } = run([ev(sk, bind(1), NOW - 200), ev(sk, bind(2, { node_id: NODE2 }), NOW - 100)]);
    expect(outs).toEqual(["accepted", "accepted"]);
    expect(bindingStatus(s, NOW)).toBe("matches_observed_binding");
    expect(matchEndpoint(s, NOW, { node_id: NODE2 })).toBe("matches_observed_binding");
    expect(matchEndpoint(s, NOW, { node_id: NODE })).toBe("mismatch");
  });
  it("higher version without higher created_at -> conflict", () => {
    expect(run([ev(sk, bind(1), NOW - 100), ev(sk, bind(2), NOW - 100)]).outs[1]).toBe("conflict");
    expect(run([ev(sk, bind(1), NOW - 100), ev(sk, bind(2), NOW - 200)]).outs[1]).toBe("conflict");
  });
  it("lower version with newer created_at (relays would serve it) -> conflict", () => {
    const { s, outs } = run([ev(sk, bind(5), NOW - 200), ev(sk, bind(3), NOW - 100)]);
    expect(outs[1]).toBe("conflict"); expect(bindingStatus(s, NOW)).toBe("conflict");
  });
  it("far-future created_at is rejected", () => {
    expect(run([ev(sk, bind(1), NOW + 3600)]).outs[0]).toBe("ignored_future");
  });
  it("a huge version jump -> conflict", () => {
    expect(run([ev(sk, bind(1), NOW - 200), ev(sk, bind(1_000_000), NOW - 100)]).outs[1]).toBe("conflict");
  });
  it("same version, different content -> conflict carrying BOTH signed events", () => {
    const a = ev(sk, bind(4), NOW - 200), b = ev(sk, bind(4, { node_id: NODE2 }), NOW - 100);
    const { s, outs } = run([a, b]);
    expect(outs[1]).toBe("conflict");
    expect(s!.conflicts[0]!.events.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    expect(s!.conflicts[0]!.events.every((e) => typeof e.sig === "string" && e.sig.length === 128)).toBe(true);
  });
  it("the same event twice is a duplicate, not a conflict", () => {
    const a = ev(sk, bind(1));
    expect(run([a, a]).outs).toEqual(["accepted", "duplicate"]);
  });
  it("revocation is terminal: any later state from that key, at any version, is ignored", () => {
    const { s, outs } = run([ev(sk, bind(1), NOW - 300), ev(sk, { revoked: true, version: 1 }, NOW - 200), ev(sk, bind(999), NOW - 100)]);
    expect(outs).toEqual(["accepted", "revoked", "ignored_after_revoke"]);
    expect(bindingStatus(s, NOW)).toBe("revoked");
  });
  it("revocation beats a future-dated state within skew S", () => {
    const { s } = run([ev(sk, bind(1), NOW - 300), ev(sk, bind(2), NOW + 300), ev(sk, { revoked: true, version: 0 }, NOW - 10)]);
    expect(bindingStatus(s, NOW)).toBe("revoked");
  });
  it("expired, revoked and url_only are never a match", () => {
    const exp = run([ev(sk, bind(1, { node_id: NODE }, NOW - 1))]).s;
    expect(matchEndpoint(exp, NOW, { node_id: NODE })).toBe("expired");
    const url = run([ev(sk, bind(1, { lud16: "shop@example.com" }))]).s;
    expect(bindingStatus(url, NOW)).toBe("url_only");
    expect(matchEndpoint(url, NOW, { node_id: NODE })).toBe("url_only");
    const rev = run([ev(sk, bind(1)), ev(sk, { revoked: true, version: 1 }, NOW - 50)]).s;
    expect(matchEndpoint(rev, NOW, { node_id: NODE })).toBe("revoked");
    expect(matchEndpoint(undefined, NOW, { node_id: NODE })).toBe("none");
    expect(matchEndpoint("unknown", NOW, { node_id: NODE })).toBe("unknown");
  });
  it("a URL binding plus a lightning address presented is url_only even with an offer present elsewhere", () => {
    const s = run([ev(sk, bind(1, { node_id: NODE, lud16: "shop@example.com" }))]).s;
    expect(matchEndpoint(s, NOW, { lud16: "shop@example.com" })).toBe("url_only");
  });
});

describe("binding claims without proof / forgeries", () => {
  const sk = key();
  it("rejects a tampered (forged) event, wrong kind, wrong d, non-canonical or unknown content", () => {
    const good = ev(sk, bind(1));
    const forged = { ...good, content: canonicalJson(bind(1, { node_id: NODE2 })) };
    expect(run([forged]).outs[0]).toMatch(/^rejected:/);
    expect(run([ev(sk, bind(1), NOW - 100, { kind: 30078 })]).outs[0]).toMatch(/^rejected:wrong kind/);
    expect(run([ev(sk, bind(1), NOW - 100, { d: "other" })]).outs[0]).toBe("rejected:wrong d tag");
    expect(run([ev(sk, null, NOW - 100, { raw: JSON.stringify({ version: 1, expires_at: NOW + 9, endpoints: { node_id: NODE } }, null, 1) })]).outs[0]).toBe("rejected:content not canonical");
    expect(run([ev(sk, { ...bind(1), score: 5 })]).outs[0]).toBe("rejected:unknown content field");
    expect(run([ev(sk, bind(1, { node_id: "zz" }))]).outs[0]).toBe("rejected:bad node_id");
    expect(run([ev(sk, bind(1, { cashu_mints: ["http://mint.test"] }))]).outs[0]).toBe("rejected:bad cashu_mints");
  });
  it("another key cannot write into a store key's binding state", () => {
    const a = run([ev(sk, bind(1))]).s!;
    const r = applyBinding(a, ev(key(), bind(2), NOW - 50), NOW);
    expect(r.outcome).toBe("rejected:wrong store key");
    expect(bindingStatus(r.state, NOW)).toBe("matches_observed_binding");
  });
  it("no binding event at all -> none, and harness-only fields stay unknown (a self-minted preimage changes nothing)", () => {
    const f = typedFields(null, NOW, "snap-1");
    expect(f.endpoint_binding).toEqual({ value: "none", provenance: "observed" });
    expect(f.payment_bound_to_order.value).toBe("unknown");
    expect(f.settlement_mode_verified.value).toBe("unknown");
  });
});

describe("one operator with ten keys", () => {
  it("each key is its own store: same node id bound ten times gives ten independent facts and no score", () => {
    const keys = Array.from({ length: 10 }, key);
    const states = keys.map((k) => run([ev(k, bind(1), NOW - 10 * 86400)], NOW).s!);
    for (const s of states) expect(bindingStatus(s, NOW)).toBe("matches_observed_binding");
    // key_first_seen is KlickyMart's clock, not the (backdated) created_at
    for (const s of states) expect(s.first_seen).toBe(NOW);
    const head: HeadPayload = { type: "klickymart-head", v: 1, snapshot_id: "s", sequence: 1, created_at: NOW, expires_at: NOW + 60, prev_head: null };
    const one = JSON.stringify(buildResult(states[0]!, keys.map(pk)[0]!, "nonce-123", head, NOW));
    const ten = states.map((s, i) => JSON.stringify(buildResult(s, pk(keys[i]!), "nonce-123", head, NOW)));
    for (const r of [one, ...ten]) expect(r).not.toMatch(/"(score|rank|ranking|weight|trust|tip)[a-z_]*"\s*:/i);
    // a fact about key 0 is not changed by keys 1..9 existing
    expect(JSON.parse(ten[0]!).fields).toEqual(JSON.parse(one).fields);
  });
  it("revoking one key leaves the other keys untouched and does not move between keys", () => {
    const a = key(), b = key();
    const sa = run([ev(a, bind(1)), ev(a, { revoked: true, version: 1 }, NOW - 50)]).s;
    const sb = run([ev(b, bind(1))]).s;
    expect(bindingStatus(sa, NOW)).toBe("revoked");
    expect(bindingStatus(sb, NOW)).toBe("matches_observed_binding");
  });
});

describe("Satoshi m2 answers", () => {
  const sk = key();
  it("content carries ONLY v9.2 §2 fields: anything else is rejected", () => {
    expect(run([ev(sk, { ...bind(1), settlement_modes: ["prepay"] })]).outs[0]).toBe("rejected:unknown content field");
    expect(run([ev(sk, bind(1, { node_id: NODE, settlement_mode: "prepay" }))]).outs[0]).toBe("rejected:unknown endpoint settlement_mode");
    expect(run([ev(sk, { revoked: false, version: 1 })]).outs[0]).toBe("rejected:bad revoke");
    expect(run([ev(sk, { version: 1, endpoints: { node_id: NODE } })]).outs[0]).toBe("rejected:missing expires_at");
    for (const e of [{ bolt12_offer: "lno1" + "q".repeat(40) }, { node_id: NODE }, { lud16: "a@b.example" }, { lnurl: "lnurl1" + "d".repeat(40) }, { cashu_mints: ["https://mint.test"] }])
      expect(run([ev(sk, bind(1, e))]).outs[0]).toBe("accepted");
  });
  it("history cap never drops evidence: first state, every conflict pair and the revoke survive; only ordinary states are capped at 32", () => {
    const evs: BEv[] = [];
    for (let v = 1; v <= 40; v++) evs.push(ev(sk, bind(v), NOW - 10_000 + v * 10));
    const c1 = ev(sk, bind(5, { node_id: NODE2 }), NOW - 1000);          // equivocation on an old, already-capped version
    const c2 = ev(sk, bind(41), NOW - 10_000 + 400);                       // higher version, created_at not higher
    const rv = ev(sk, { revoked: true, version: 99 }, NOW - 500);
    const { s, outs } = run([...evs, c1, c2, rv]);
    expect(outs.slice(40)).toEqual(["conflict", "conflict", "revoked"]);
    expect(s!.seen.length).toBe(32);
    expect(s!.first!.id).toBe(evs[0]!.id);
    expect(s!.conflicts.length).toBe(2);
    expect(s!.revoked!.id).toBe(rv.id);
    const ids = new Set(evs.slice(0, 1).concat(c1, c2, rv, evs[39]!).map((e) => e.id));
    const evidence = new Set(run([...evs, c1, c2, rv]).s!.seen.map((x) => x.ev.id));
    for (const e of [evs[0]!, c1, c2, rv]) expect(evidence.has(e.id)).toBe(false); // they live outside the capped list...
    const carried = new Set((buildResult(s!, pk(sk), "nonce-xyz-1", { type: "klickymart-head", v: 1, snapshot_id: "s", sequence: 1, created_at: NOW, expires_at: NOW + 60, prev_head: null }, NOW).raw_events).map((e) => e.id));
    for (const id of ids) expect(carried.has(id)).toBe(true);              // ...and are always carried as evidence
  });
  it("conflict is permanent for the key, and the current state is shown beside it", () => {
    const a = ev(sk, bind(1), NOW - 300), b = ev(sk, bind(1, { node_id: NODE2 }), NOW - 200), up = ev(sk, bind(2), NOW - 100);
    const { s, outs } = run([a, b, up]);
    expect(outs).toEqual(["accepted", "conflict", "accepted"]);
    expect(bindingStatus(s, NOW)).toBe("conflict");
    expect(bindingStatus(s, NOW, { ignoreConflict: true })).toBe("matches_observed_binding");
    const f = typedFields(s!, NOW, "snap");
    expect(f.endpoint_binding.value).toBe("conflict");
    expect(f.current_binding).toEqual({ value: "matches_observed_binding", provenance: "observed" });
    expect(s!.latest!.id).toBe(up.id);
    // and the harness accepts it, checking current_binding against the raw events too
    const head: HeadPayload = { type: "klickymart-head", v: 1, snapshot_id: "snap-c", sequence: 3, created_at: NOW, expires_at: NOW + 3600, prev_head: null };
    const res = buildResult(s!, pk(sk), "nonce-abc-123", head, NOW);
    expect(verifyResult(signResult(res, KM_HEX), signHead(head, KM_HEX), { pinned: KM_PK, nonce: "nonce-abc-123", nowS: NOW + 1, highWater: 3 })).toMatchObject({ ok: true, status: "conflict" });
    const lie = structuredClone(res); lie.raw_events = lie.raw_events.filter((e) => e.id !== up.id && e.id !== a.id && e.id !== b.id);
    expect(verifyResult(signResult(lie, KM_HEX), signHead(head, KM_HEX), { pinned: KM_PK, nonce: "nonce-abc-123", nowS: NOW + 1, highWater: 3 })).toMatchObject({ ok: false });
  });
  it("lower version + newer created_at stays a conflict", () => {
    expect(run([ev(sk, bind(9), NOW - 200), ev(sk, bind(8), NOW - 100)]).outs[1]).toBe("conflict");
  });
});

describe("Satoshi follow-ups: permanent version index, terminal revoke", () => {
  const H = (seq = 4): HeadPayload => ({ type: "klickymart-head", v: 1, snapshot_id: `snap-${seq}`, sequence: seq, created_at: NOW, expires_at: NOW + 3600, prev_head: null });
  const check = (res: ResultPayload, head = H()) => verifyResult(signResult(res, KM_HEX), signHead(head, KM_HEX), { pinned: KM_PK, nonce: "nonce-abc-123", nowS: NOW + 1, highWater: head.sequence });
  it("the reported gap: equivocation on a version whose bytes left the 32-state history, with an OLDER created_at, is a conflict (hash-only old side, marked)", () => {
    const sk = key(); const evs: BEv[] = [];
    for (let v = 1; v <= 40; v++) evs.push(ev(sk, bind(v), NOW - 10_000 + v * 10));
    const old5 = evs[4]!;
    const twin = ev(sk, bind(5, { node_id: NODE2 }), NOW - 10_000 + 5);   // older created_at than the v5 we accepted
    const { s, outs } = run([...evs, twin]);
    expect(s!.seen.some((x) => x.ev.id === old5.id)).toBe(false);          // old bytes are gone from the capped list
    expect(outs[40]).toBe("conflict");
    expect(bindingStatus(s, NOW)).toBe("conflict");
    const c = s!.conflicts[0]!;
    expect(c.events.map((e) => e.id)).toEqual([twin.id]);
    expect(c.old_ref).toEqual({ hash: hashHex(old5.content), created_at: old5.created_at, id: old5.id, version: 5 });
    expect(c.marks).toEqual(["evidence_hash_only_old_side"]);
    // results carry the shape; the wallet check accepts it and surfaces the weaker-evidence mark
    const res = buildResult(s!, pk(sk), "nonce-abc-123", H(), NOW);
    expect(res.conflict_refs).toEqual([{ version: 5, old_hash: hashHex(old5.content), old_id: old5.id, old_created_at: old5.created_at, new_id: twin.id, marks: ["evidence_hash_only_old_side"] }]);
    expect(res.raw_events.some((e) => e.id === twin.id)).toBe(true);
    expect(check(res)).toMatchObject({ ok: true, status: "conflict", marks: ["evidence_hash_only_old_side"] });
    // tampering with the ref shape is caught
    const noMark = structuredClone(res); noMark.conflict_refs[0]!.marks = [];
    expect(check(noMark)).toMatchObject({ ok: false, reason: "result: conflict_ref not marked as hash-only evidence" });
    const sameHash = structuredClone(res); sameHash.conflict_refs[0]!.old_hash = hashHex(twin.content);
    expect(check(sameHash)).toMatchObject({ ok: false, reason: "result: conflict_ref does not show a conflict" });
    const missing = structuredClone(res); missing.raw_events = missing.raw_events.filter((e) => e.id !== twin.id);
    expect(check(missing)).toMatchObject({ ok: false, reason: "result: conflict_ref new event missing" });
  });
  it("known version + different content is a conflict regardless of created_at; while the old bytes are held, both events are carried", () => {
    const sk = key();
    for (const at of [NOW - 500, NOW - 100]) {
      const { s, outs } = run([ev(sk, bind(1), NOW - 300), ev(sk, bind(2), NOW - 200), ev(sk, bind(1, { node_id: NODE2 }), at)]);
      expect(outs[2]).toBe("conflict");
      expect(s!.conflicts[0]!.events.length).toBe(2); expect(s!.conflicts[0]!.marks).toEqual([]);
    }
    expect(run([ev(sk, bind(1), NOW - 300), ev(sk, bind(1), NOW - 300)]).outs[1]).toBe("duplicate");
  });
  it("the version index is permanent (kept in state and in D1, never capped)", async () => {
    const sk = key(); const t = Math.floor(Date.now() / 1000);
    const evs = Array.from({ length: 40 }, (_, i) => ev(sk, { version: i + 1, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 1000 + i));
    for (const e of evs) await ingestEvents(env.DB, [{ ev: e, relay: "r" }], ctx());
    const s = await loadBindingState(env.DB, pk(sk)) as BindingState;
    expect(Object.keys(s.versions).length).toBe(40);
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM endpoint_binding_versions WHERE pubkey = ?").bind(pk(sk)).first<{ c: number }>())!.c).toBe(40);
    // v1 is the first state (kept forever, full bytes); v2 has left the capped history (hash-only old side)
    const twin = ev(sk, { version: 2, expires_at: t + 86400, endpoints: { node_id: NODE2 } }, t - 2000);
    await ingestEvents(env.DB, [{ ev: twin, relay: "r" }], ctx());
    const s2 = await loadBindingState(env.DB, pk(sk)) as BindingState;
    expect(bindingStatus(s2, t)).toBe("conflict");
    expect(s2.conflicts[0]!.marks).toEqual(["evidence_hash_only_old_side"]);
  });
  it("revoke is terminal with a stale version, a future created_at, or extra fields (expires_at/endpoints never used)", () => {
    const sk = key();
    const cases = [
      ev(sk, { revoked: true, version: 0 }, NOW - 50),                                     // stale version
      ev(sk, { revoked: true }, NOW + 86400 * 365),                                        // far-future created_at, no version
      ev(sk, null, NOW - 50, { raw: JSON.stringify({ revoked: true, version: 7, expires_at: NOW + 99, endpoints: { node_id: NODE2 }, note: "x" }) }), // extra fields, non-canonical
    ];
    for (const rv of cases) {
      const { s, outs } = run([ev(sk, bind(5), NOW - 100), rv, ev(sk, bind(6), NOW - 10)]);
      expect(outs).toEqual(["accepted", "revoked", "ignored_after_revoke"]);
      expect(bindingStatus(s, NOW)).toBe("revoked");
      expect(matchEndpoint(s, NOW, { node_id: NODE2 })).toBe("revoked");
      expect(s!.latest!.content).toBe(canonicalJson(bind(5)));                        // revoke's endpoints never adopted
    }
    // a revoke as the very first event also ends the key
    expect(run([ev(sk, { revoked: true }, NOW), ev(sk, bind(1), NOW + 1)]).outs).toEqual(["revoked", "ignored_after_revoke"]);
  });
  it("revoke on the wrong kind, wrong d tag, bad signature or another author is rejected", () => {
    const sk = key();
    const base = run([ev(sk, bind(1), NOW - 100)]).s!;
    const wrongKind = ev(sk, { revoked: true }, NOW - 10, { kind: 30078 });
    const wrongD = ev(sk, { revoked: true }, NOW - 10, { d: "other" });
    const good = ev(sk, { revoked: true }, NOW - 10);
    const badSig = { ...good, sig: "00".repeat(64) };
    const otherAuthor = ev(key(), { revoked: true }, NOW - 10);
    expect(applyBinding(base, wrongKind, NOW).outcome).toMatch(/^rejected:wrong kind/);
    expect(applyBinding(base, wrongD, NOW).outcome).toBe("rejected:wrong d tag");
    expect(applyBinding(base, badSig, NOW).outcome).toMatch(/^rejected:/);
    expect(applyBinding(base, otherAuthor, NOW).outcome).toBe("rejected:wrong store key");
    for (const e of [wrongKind, wrongD, badSig, otherAuthor]) expect(bindingStatus(applyBinding(base, e, NOW).state, NOW)).toBe("matches_observed_binding");
  });
  it("ingest: a far-future revoke is stored as terminal evidence", async () => {
    const sk = key(); const now = Date.now(); const t = Math.floor(now / 1000);
    await ingestEvents(env.DB, [{ ev: ev(sk, { version: 1, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 100), relay: "r" }], ctx({ now }));
    const rv = ev(sk, { revoked: true, version: 0 }, t + 86400);
    const r = await ingestEvents(env.DB, [{ ev: rv, relay: "r" }], ctx({ now }));
    expect(r.accepted).toBe(1);
    expect(bindingStatus(await loadBindingState(env.DB, pk(sk)), t)).toBe("revoked");
    expect((await env.DB.prepare("SELECT outcome FROM endpoint_binding_events WHERE id = ?").bind(rv.id).first<{ outcome: string }>())!.outcome).toBe("revoked");
  });
});

// ---------- signed results + reference harness ----------
const KM = key(); const KM_PK = pk(KM); const KM_HEX = bytesToHex(KM);
function setup(evs: BEv[], storeSk: Uint8Array, nonce = "nonce-abc-123", now = NOW, seq = 7) {
  const s = run(evs, now).s ?? null;
  const head: HeadPayload = { type: "klickymart-head", v: 1, snapshot_id: `snap-${seq}`, sequence: seq, created_at: now, expires_at: now + 3600, prev_head: null };
  return { head: signHead(head, KM_HEX), res: signResult(buildResult(s, pk(storeSk), nonce, head, now), KM_HEX), headP: head, s };
}
const opts = (o: Partial<Parameters<typeof verifyResult>[2]> = {}) => ({ pinned: KM_PK, nonce: "nonce-abc-123", nowS: NOW + 5, highWater: 7, ...o });

describe("signed results (v9.2 §1 acceptance)", () => {
  const store = key();
  const evs = [ev(store, bind(1, { node_id: NODE }, NOW + 300))];
  it("a valid result verifies; acceptance ends at the earliest of result, head and binding expiry", () => {
    const { head, res } = setup(evs, store);
    const v = verifyResult(res, head, opts());
    expect(v).toEqual({ ok: true, acceptUntil: NOW + 300, status: "matches_observed_binding" });
    expect(res.payload.nonce).toBe("nonce-abc-123");
    expect(res.payload.sequence).toBe(7);
    expect(res.payload.fields.not_payment_authorization.value).toBe(true);
    for (const f of Object.values(res.payload.fields)) expect(f).toHaveProperty("provenance");
  });
  it("forged: any edited field breaks the signature", () => {
    const { head, res } = setup([ev(store, bind(1, { lud16: "shop@example.com" }))], store);
    const edited = structuredClone(res); edited.payload.fields.endpoint_binding.value = "matches_observed_binding";
    expect(verifyResult(edited, head, opts())).toMatchObject({ ok: false, reason: "result: id does not match payload" });
    const sig = structuredClone(res); sig.sig = "00".repeat(64);
    expect(verifyResult(sig, head, opts())).toMatchObject({ ok: false });
  });
  it("forged: a result re-signed by any other key is rejected", () => {
    const evil = key();
    const { headP } = setup(evs, store);
    const r = signResult(buildResult(run(evs).s!, pk(store), "nonce-abc-123", headP, NOW), bytesToHex(evil));
    expect(verifyResult(r, signHead(headP, bytesToHex(evil)), opts())).toMatchObject({ ok: false, reason: "head: not signed by the pinned KlickyMart key" });
    expect(verifyResult(r, signHead(headP, KM_HEX), opts())).toMatchObject({ ok: false, reason: "result: not signed by the pinned KlickyMart key" });
  });
  it("replayed: a result for another request's nonce is rejected", () => {
    const { head, res } = setup(evs, store, "someone-elses-nonce");
    expect(verifyResult(res, head, opts())).toMatchObject({ ok: false, reason: "result: nonce mismatch (replay?)" });
  });
  it("replayed: a lower sequence than the stored high-water mark is rollback", () => {
    const { head, res } = setup(evs, store, "nonce-abc-123", NOW, 6);
    expect(verifyResult(res, head, opts())).toMatchObject({ ok: false, reason: "head: sequence below high-water (rollback)" });
  });
  it("replayed: a result paired with a different head is rejected", () => {
    const a = setup(evs, store, "nonce-abc-123", NOW, 8), b = setup(evs, store, "nonce-abc-123", NOW, 9);
    expect(verifyResult(a.res, b.head, opts())).toMatchObject({ ok: false, reason: "result: not bound to this head" });
  });
  it("stale result, expired head, and future-dated expires_at beyond the TTL cap", () => {
    const { head, res } = setup(evs, store);
    expect(verifyResult(res, head, opts({ nowS: NOW + 1000, maxAgeS: 900 }))).toMatchObject({ ok: false, reason: "result: stale (older than max age)" });
    expect(verifyResult(res, head, opts({ nowS: NOW + 4000, maxAgeS: 99999 }))).toMatchObject({ ok: false, reason: "head: expired" });
    // KlickyMart signs a result claiming a year of validity: the harness clamps it to its own cap
    const { headP } = setup(evs, store);
    const long: ResultPayload = { ...buildResult(run(evs).s!, pk(store), "nonce-abc-123", headP, NOW), expires_at: NOW + 365 * 86400 };
    const longHead = signHead({ ...headP, expires_at: NOW + 365 * 86400 }, KM_HEX);
    expect(verifyResult(signResult(long, KM_HEX), longHead, opts({ nowS: NOW + 700, maxAgeS: 99999, resultTtlCapS: 600 }))).toMatchObject({ ok: false, reason: "result: expired" });
    expect(verifyResult(signResult(long, KM_HEX), longHead, opts({ nowS: NOW + 3700, maxAgeS: 99999, resultTtlCapS: 99999 }))).toMatchObject({ ok: false, reason: "head: expired" });
  });
  it("a signed claim of 'matches' that the raw events don't support is rejected", () => {
    const { headP } = setup(evs, store);
    const lie = buildResult(null, pk(store), "nonce-abc-123", headP, NOW); lie.fields.endpoint_binding.value = "matches_observed_binding";
    expect(verifyResult(signResult(lie, KM_HEX), signHead(headP, KM_HEX), opts())).toMatchObject({ ok: false, reason: "result: claims matches_observed_binding but raw events say none" });
    const rev = run([...evs, ev(store, { revoked: true, version: 1 }, NOW - 50)]).s!;
    const lie2 = buildResult(rev, pk(store), "nonce-abc-123", headP, NOW); lie2.fields.endpoint_binding.value = "matches_observed_binding";
    expect(verifyResult(signResult(lie2, KM_HEX), signHead(headP, KM_HEX), opts())).toMatchObject({ ok: false, reason: "result: claims matches_observed_binding but raw events say revoked" });
    const other = buildResult(run(evs).s!, pk(key()), "nonce-abc-123", headP, NOW);
    expect(verifyResult(signResult(other, KM_HEX), signHead(headP, KM_HEX), opts())).toMatchObject({ ok: false, reason: "result: raw event from another key" });
  });
  it("harness-only fields must be unknown, even when correctly signed", () => {
    const { headP } = setup(evs, store);
    const r = buildResult(run(evs).s!, pk(store), "nonce-abc-123", headP, NOW);
    (r.fields.payment_bound_to_order as { value: unknown }).value = true;
    expect(verifyResult(signResult(r, KM_HEX), signHead(headP, KM_HEX), opts())).toMatchObject({ ok: false, reason: "result: harness-only field payment_bound_to_order not unknown" });
  });
  it("requireKeyStatement (M3) rejects results without a key-statement hash", () => {
    const { head, res } = setup(evs, store);
    expect(verifyResult(res, head, opts({ requireKeyStatement: true }))).toMatchObject({ ok: false, reason: "result: no key statement" });
  });
  it("liveness: cached unexpired state is used, then payments fail closed; relay-only only when opted in", () => {
    expect(paymentGate({ acceptUntil: NOW + 10 }, NOW)).toBe("use_cache");
    expect(paymentGate({ acceptUntil: NOW - 1 }, NOW)).toBe("fail_closed");
    expect(paymentGate(null, NOW)).toBe("fail_closed");
    expect(paymentGate(null, NOW, true)).toBe("relay_only");
  });
});

// ---------- ingest + routes + kill switches ----------
const ctx = (extra: Partial<IngestCtx> = {}): IngestCtx => ({ domains: new Set(["example.com"]), ourPubkey: null, endpointBindings: true, ...extra });
beforeEach(async () => { for (const t of ["endpoint_binding_events", "endpoint_binding_state", "snapshot_heads"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("KM_ENDPOINT_BINDINGS kill switch", () => {
  it("parses the flag (default OFF; only explicit on enables)", () => {
    expect(bindingsEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "off", " OFF ", "yes"]) expect(bindingsEnabled({ KM_ENDPOINT_BINDINGS: v })).toBe(false);
    for (const v of ["1", "true", "on", " ON "]) expect(bindingsEnabled({ KM_ENDPOINT_BINDINGS: v })).toBe(true);
    expect(bindingsEnabled(env as never)).toBe(false); // wrangler.toml vars ship it off
  });
  it("unset in the ingest ctx: kind not followed, nothing stored", async () => {
    const sk = key(); const now = Date.now(); const t = Math.floor(now / 1000);
    const a = ev(sk, { version: 1, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 100);
    const r = await ingestEvents(env.DB, [{ ev: a, relay: "wss://r.test" }], { domains: new Set(["example.com"]), ourPubkey: null, now });
    expect(r.accepted).toBe(0);
    expect(JSON.stringify(buildFilters({ domains: new Set(["example.com"]), ourPubkey: null }, 0))).not.toContain(`"kinds":[${K}]`);
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM endpoint_binding_events").first<{ c: number }>())!.c).toBe(0);
  });
  it("on: ingest stores state + evidence; conflicts keep both events", async () => {
    const sk = key(); const now = Date.now(); const t = Math.floor(now / 1000);
    const a = ev(sk, { version: 1, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 100);
    const b = ev(sk, { version: 1, expires_at: t + 86400, endpoints: { node_id: NODE2 } }, t - 50);
    const r = await ingestEvents(env.DB, [{ ev: a, relay: "wss://r.test" }, { ev: b, relay: "wss://r.test" }], ctx({ now }));
    expect(r.accepted).toBe(2);
    const s = await loadBindingState(env.DB, pk(sk));
    expect(bindingStatus(s, t)).toBe("conflict");
    expect((await env.DB.prepare("SELECT COUNT(*) AS c FROM endpoint_binding_events").first<{ c: number }>())!.c).toBe(2);
    expect(JSON.stringify(buildFilters(ctx(), 0))).toContain(`"kinds":[${K}]`);
  });
  it("off: no filter, kind not followed, nothing stored", async () => {
    const sk = key(); const now = Date.now(); const t = Math.floor(now / 1000);
    const a = ev(sk, { version: 1, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 100);
    const r = await ingestEvents(env.DB, [{ ev: a, relay: "wss://r.test" }], ctx({ now, endpointBindings: false }));
    expect(r.accepted).toBe(0); expect(r.reasons["kind not followed"]).toBe(1);
    expect(JSON.stringify(buildFilters(ctx({ endpointBindings: false }), 0))).not.toContain(`"kinds":[${K}]`);
    for (const tb of ["endpoint_binding_events", "endpoint_binding_state"]) expect((await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${tb}`).first<{ c: number }>())!.c).toBe(0);
  });
});

describe("ignored events are counted, not stored", () => {
  it("post-revocation, future-dated and stale replays: per-key counter + last ignored hash only", async () => {
    const sk = key(); const now = Date.now(); const t = Math.floor(now / 1000);
    const mk = (c: unknown, at: number) => ev(sk, c, at);
    const v2 = mk({ version: 2, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 500);
    const stale = mk({ version: 1, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 900);
    const fut = mk({ version: 3, expires_at: t + 86400, endpoints: { node_id: NODE } }, t + 7200);
    await ingestEvents(env.DB, [{ ev: v2, relay: "r" }], ctx({ now }));
    await ingestEvents(env.DB, [{ ev: stale, relay: "r" }], ctx({ now })); // replayed later: older version and older created_at
    await ingestEvents(env.DB, [{ ev: fut, relay: "r" }], ctx({ now }));
    const rv = mk({ revoked: true, version: 2 }, t - 100);
    await ingestEvents(env.DB, [{ ev: rv, relay: "r" }], ctx({ now }));
    const after = mk({ version: 4, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 50);
    await ingestEvents(env.DB, [{ ev: after, relay: "r" }], ctx({ now }));
    const stored = (await env.DB.prepare("SELECT id, outcome FROM endpoint_binding_events ORDER BY created_at").all<{ id: string; outcome: string }>()).results;
    expect(stored.map((x) => [x.id, x.outcome])).toEqual([[v2.id, "accepted"], [rv.id, "revoked"]]);
    const row = await env.DB.prepare("SELECT ignored_count, last_ignored_hash FROM endpoint_binding_state WHERE pubkey = ?").bind(pk(sk)).first<{ ignored_count: number; last_ignored_hash: string }>();
    expect(row).toEqual({ ignored_count: 3, last_ignored_hash: after.id });
    expect(JSON.stringify(await loadBindingState(env.DB, pk(sk)))).not.toContain(after.sig);
  });
});

describe("open-store routes + KM_SIGNED_RESULTS kill switch", () => {
  it("parses the flag (default OFF; only explicit on enables)", () => {
    expect(signedResultsEnabled({})).toBe(false);
    for (const v of ["", "0", "false", "off"]) expect(signedResultsEnabled({ KM_SIGNED_RESULTS: v })).toBe(false);
    for (const v of ["1", "true", "on"]) expect(signedResultsEnabled({ KM_SIGNED_RESULTS: v })).toBe(true);
    expect(signedResultsEnabled(env as never)).toBe(false); // wrangler.toml vars ship it off
  });
  it("503 without a key or without a fresh head; never an unsigned fact", async () => {
    const u = new URL("https://x/open-store/head");
    expect((await openStoreRoute("/open-store/head", u, { ...env, KM_RESULT_SK_HEX: undefined } as never)).status).toBe(503);
    expect((await openStoreRoute("/open-store/head", u, { ...env, KM_RESULT_SK_HEX: KM_HEX } as never)).status).toBe(503);
  });
  it("serves a signed head and a signed result that the reference harness accepts", async () => {
    const t = Math.floor(Date.now() / 1000);
    expect(await recordSnapshotHead(env.DB, "snap-a", t - 10)).toBe(0);
    expect(await recordSnapshotHead(env.DB, "snap-b", t)).toBe(1);
    expect((await latestHead(env.DB, t))!.prev_head).toBe("0:snap-a");
    const sk = key();
    await ingestEvents(env.DB, [{ ev: ev(sk, { version: 1, expires_at: t + 86400, endpoints: { node_id: NODE } }, t - 100), relay: "wss://r.test" }], ctx());
    const e = { ...env, KM_RESULT_SK_HEX: KM_HEX } as never;
    const res = await openStoreRoute("/open-store/binding", new URL(`https://x/open-store/binding?pubkey=${pk(sk)}&nonce=harness-n-1`), e);
    expect(res.status).toBe(200);
    const body = await res.json() as { head: Signed<HeadPayload>; result: Signed<ResultPayload> };
    expect(verifyResult(body.result, body.head, { pinned: KM_PK, nonce: "harness-n-1", nowS: t + 1, highWater: 1 })).toMatchObject({ ok: true, status: "matches_observed_binding" });
    expect(JSON.stringify(body)).not.toContain(KM_HEX);
    expect((await openStoreRoute("/open-store/binding", new URL(`https://x/open-store/binding?pubkey=${pk(sk)}`), e)).status).toBe(400);
  });
  it("off: the routes do not exist (same response as any unknown path)", async () => {
    const t = Math.floor(Date.now() / 1000); await recordSnapshotHead(env.DB, "snap-z", t);
    const off = await handleRequest(new Request("https://x/open-store/head"), { ...env, KM_SIGNED_RESULTS: "off", KM_RESULT_SK_HEX: KM_HEX } as never);
    const unknown = await handleRequest(new Request("https://x/open-store-nope"), { ...env } as never);
    expect(off.status).toBe(unknown.status);
    expect(await off.text()).not.toContain("klickymart-head");
    for (const p of ["/open-store/head", "/open-store/binding?pubkey=" + "a".repeat(64) + "&nonce=n"]) {
      const dflt = await handleRequest(new Request("https://x" + p), { ...env, KM_SIGNED_RESULTS: undefined, KM_RESULT_SK_HEX: KM_HEX } as never);
      expect(dflt.status).toBe(unknown.status); // unset = off
    }
    const on = await handleRequest(new Request("https://x/open-store/head"), { ...env, KM_SIGNED_RESULTS: "on", KM_RESULT_SK_HEX: KM_HEX } as never);
    expect(on.status).toBe(200);
  });
});

describe("binding kind placeholder", () => {
  it("does not collide with the draft product-offer kind 31421", async () => {
    const { NOSTR_KIND_ENDPOINT_BINDING } = await import("../src/nostr-kinds");
    expect(NOSTR_KIND_ENDPOINT_BINDING).toBe(31431);
    expect(NOSTR_KIND_ENDPOINT_BINDING).not.toBe(31421);
  });
});
