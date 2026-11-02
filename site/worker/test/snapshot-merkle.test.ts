import { wipe } from "./helpers/wipe";
import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EMPTY_ROOT, buildLevels, digestOf, leafFor, leafHash, nodeHash, proofFromLevels, rootOf, sortLeaves, verifyProof, type MerkleProof } from "../src/merkle";
import { MAX_TREE_ROWS, loadProof, snapshotDigestEnabled, treeFor } from "../src/snapshot-tree";
import { writeDailyHead } from "../src/open-store";
import { latestHead } from "../src/signed-result";
import { handleRequest } from "../src/router";

const rec = (i: number) => ({ d: `shop-${String(i).padStart(4, "0")}.example`, raw_json: JSON.stringify({ d: `shop-${i}`, v: "0.5", n: i }) });
const rows = (n: number) => Array.from({ length: n }, (_, i) => rec(i));
const tree = (n: number) => { const sorted = sortLeaves(rows(n).map((r) => leafFor(r.d, r.raw_json))); return { sorted, levels: buildLevels(sorted) }; };
const H = (c: string) => c.repeat(64);

describe("merkle: hashing", () => {
  it("domain separation: leaf, node, empty and digest tags never collide", () => {
    const l = leafHash({ d: "a", raw_sha256: H("0") });
    expect(new Set([l, nodeHash(H("0"), H("0")), EMPTY_ROOT, digestOf(0, EMPTY_ROOT), digestOf(1, l)]).size).toBe(5);
    expect(leafHash({ d: "a", raw_sha256: H("0") })).not.toBe(leafHash({ d: "b", raw_sha256: H("0") }));
  });
  it("leaf fields are fixed and required", () => {
    expect(() => leafHash({ d: "", raw_sha256: H("0") })).toThrow();
    expect(() => leafHash({ d: "a", raw_sha256: "zz" })).toThrow();
    expect(() => leafHash({ d: "a", raw_sha256: H("A") })).toThrow(); // lowercase only
  });
  it("raw hash is canonical: key order in the record JSON does not matter; content does", () => {
    expect(leafFor("a", '{"x":1,"y":2}')).toEqual(leafFor("a", '{"y":2,"x":1}'));
    expect(leafFor("a", '{"x":1}').raw_sha256).not.toBe(leafFor("a", '{"x":2}').raw_sha256);
  });
  it("order-independent input, duplicate domains rejected", () => {
    const a = treeFor(rows(5)), b = treeFor([...rows(5)].reverse());
    expect(a.digest).toBe(b.digest);
    expect(() => treeFor([rec(1), rec(1)])).toThrow(/duplicate/);
  });
  it("empty tree: EMPTY_ROOT, count bound into the digest, no proofs", () => {
    const t = treeFor([]);
    expect(t.root).toBe(EMPTY_ROOT); expect(t.digest).toBe(digestOf(0, EMPTY_ROOT)); expect(t.count).toBe(0);
    expect(() => proofFromLevels([], [], 0)).toThrow();
  });
  it("single leaf: root = leaf hash, empty path, verifies", () => {
    const { sorted, levels } = tree(1);
    expect(rootOf(levels)).toBe(leafHash(sorted[0]!));
    const p = proofFromLevels(levels, sorted, 0);
    expect(p.path).toEqual([]); expect(verifyProof(p, p.snapshot_digest)).toEqual({ ok: true });
  });
  it("leaf count is bound: same root with a different count does not verify", () => {
    const { sorted, levels } = tree(1);
    const p = proofFromLevels(levels, sorted, 0);
    expect(verifyProof({ ...p, leaf_count: 2 }, p.snapshot_digest).ok).toBe(false);
  });
});

describe("merkle: proofs for every leaf, odd and even counts", () => {
  for (const n of [2, 3, 5, 7, 8, 9, 31, 100, 413]) {
    it(`n=${n}: every leaf verifies against the digest`, () => {
      const { sorted, levels } = tree(n);
      const dg = digestOf(n, rootOf(levels));
      for (let i = 0; i < n; i++) expect(verifyProof(proofFromLevels(levels, sorted, i), dg)).toEqual({ ok: true });
    });
  }
  it("odd node is promoted, not duplicated (3 leaves: root = H(H(l0,l1), l2))", () => {
    const { sorted, levels } = tree(3);
    const l = sorted.map(leafHash);
    expect(rootOf(levels)).toBe(nodeHash(nodeHash(l[0]!, l[1]!), l[2]!));
    // twin-tree check: [l0,l1,l2] vs [l0,l1,l2,l2] differ
    const dup = sortLeaves([...sorted, { ...sorted[2]!, d: sorted[2]!.d + "x" }]);
    expect(digestOf(4, rootOf(buildLevels(dup)))).not.toBe(digestOf(3, rootOf(levels)));
  });
});

describe("merkle: tamper detection", () => {
  const { sorted, levels } = tree(9);
  const good = proofFromLevels(levels, sorted, 4);
  const dg = good.snapshot_digest;
  const flip = (h: string) => (h[0] === "0" ? "1" : "0") + h.slice(1);
  const bad: [string, unknown][] = [
    ["raw_sha256", { ...good, raw_sha256: flip(good.raw_sha256) }],
    ["d", { ...good, d: "evil.example" }],
    ["path hash", { ...good, path: good.path.map((s, k) => (k === 1 ? { ...s, hash: flip(s.hash) } : s)) }],
    ["path side", { ...good, path: good.path.map((s, k) => (k === 0 ? { ...s, side: s.side === "L" ? "R" : "L" } : s)) }],
    ["path dropped step", { ...good, path: good.path.slice(1) }],
    ["index", { ...good, leaf_index: 5 }],
    ["root", { ...good, root: flip(good.root) }],
    ["digest", { ...good, snapshot_digest: flip(good.snapshot_digest) }],
    ["extra field", { ...good, extra: 1 }],
    ["missing field", (({ root: _r, ...x }) => x)(good)],
    ["v", { ...good, v: 2 }],
    ["not object", "x"],
  ];
  it("the untampered proof verifies", () => expect(verifyProof(good, dg)).toEqual({ ok: true }));
  for (const [name, p] of bad) it(`tampered ${name} fails`, () => expect(verifyProof(p, dg).ok).toBe(false));
  it("a valid proof against another snapshot's digest fails", () => expect(verifyProof(good, digestOf(9, H("a"))).ok).toBe(false));
  it("a changed record changes the digest", () => {
    const r = rows(9); r[4] = { ...r[4]!, raw_json: JSON.stringify({ d: "shop-4", v: "0.5", n: 999 }) };
    expect(treeFor(r).digest).not.toBe(dg);
  });
});

describe("KM_SNAPSHOT_DIGEST (D1 + routes)", () => {
  beforeEach(async () => { await wipe(env.DB, ["snapshot_heads", "snapshot_nodes", "snapshot_leaves"]); });
  const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first<{ c: number }>())!.c;
  it("default off: only 1/true/on enables", () => {
    expect(snapshotDigestEnabled({})).toBe(false); expect(snapshotDigestEnabled({ KM_SNAPSHOT_DIGEST: "off" })).toBe(false);
    for (const v of ["1", "true", "ON"]) expect(snapshotDigestEnabled({ KM_SNAPSHOT_DIGEST: v })).toBe(true);
  });
  it("flag off: head stays label-only, no tree rows (M2 behavior unchanged)", async () => {
    const t = Math.floor(Date.now() / 1000);
    expect(await writeDailyHead({ DB: env.DB, KM_SIGNED_RESULTS: "on" }, "v1", t, rows(5))).toBe(0);
    expect((await latestHead(env.DB, t))!.snapshot_digest).toBeNull();
    expect(await count("snapshot_nodes")).toBe(0);
  });
  it("flag on: digest head + stored tree; stored proofs verify for every leaf; same-second rerun leaves no orphans", async () => {
    const t = Math.floor(Date.now() / 1000), e = { DB: env.DB, KM_SIGNED_RESULTS: "on", KM_SNAPSHOT_DIGEST: "on" };
    expect(await writeDailyHead(e, "v1", t, rows(7))).toBe(0);
    const h = (await latestHead(env.DB, t))!;
    expect(h.snapshot_digest).toBe(treeFor(rows(7)).digest);
    for (const r of rows(7)) { const p = await loadProof(env.DB, 0, r.d); expect(verifyProof(p, h.snapshot_digest!)).toEqual({ ok: true }); }
    expect(await loadProof(env.DB, 0, "missing.example")).toBeNull();
    const nodes = await count("snapshot_nodes");
    expect(await writeDailyHead(e, "v1", t, rows(7))).toBeNull(); // UNIQUE snapshot_id → whole batch rolls back
    expect(await count("snapshot_nodes")).toBe(nodes); expect(await count("snapshot_heads")).toBe(1);
  });
  it("over the write budget: label-only head, no tree rows", async () => {
    const t = Math.floor(Date.now() / 1000);
    const big = Array.from({ length: Math.ceil(MAX_TREE_ROWS / 3) + 1 }, (_, i) => ({ d: `b${i}.example`, raw_json: "{}" }));
    expect(await writeDailyHead({ DB: env.DB, KM_SIGNED_RESULTS: "on", KM_SNAPSHOT_DIGEST: "on" }, "v1", t, big)).toBe(0);
    expect((await latestHead(env.DB, t))!.snapshot_digest).toBeNull(); expect(await count("snapshot_nodes")).toBe(0);
  });
  it("/open-store/proof: 404 when the flag is off; with it on, returns a signed digest head + a verifying proof", async () => {
    const t = Math.floor(Date.now() / 1000);
    await writeDailyHead({ DB: env.DB, KM_SIGNED_RESULTS: "on", KM_SNAPSHOT_DIGEST: "on" }, "v1", t, rows(5));
    const sk = bytesToHex(secp.utils.randomSecretKey());
    const base = { ...env, KM_SIGNED_RESULTS: "on", KM_RESULT_SK_HEX: sk };
    const off = await handleRequest(new Request(`https://x/open-store/proof?d=${rows(5)[2]!.d}`), base as never);
    expect(off.status).toBe(404);
    const res = await handleRequest(new Request(`https://x/open-store/proof?d=${rows(5)[2]!.d}`), { ...base, KM_SNAPSHOT_DIGEST: "on" } as never);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { head: { payload: { snapshot_digest: string } }; proof: MerkleProof };
    expect(verifyProof(j.proof, j.head.payload.snapshot_digest)).toEqual({ ok: true });
    const head = await handleRequest(new Request("https://x/open-store/head"), { ...base, KM_SNAPSHOT_DIGEST: "on" } as never);
    expect(head.status).toBe(200); // a digest head is now served
    const miss = await handleRequest(new Request("https://x/open-store/proof?d=nope.example"), { ...base, KM_SNAPSHOT_DIGEST: "on" } as never);
    expect(miss.status).toBe(404);
  });
});
