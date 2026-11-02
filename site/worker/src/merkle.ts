/** M4 S2: snapshot Merkle tree (NIP-DRAFT "snapshot_digest"). Pure functions; no I/O.
 *
 * Fixed leaf fields (all required): d (store domain, non-empty, unique) and raw_sha256 = sha256(canonicalJson(record)).
 * Leaves are sorted by d (byte order; duplicates rejected). Domain-separated hashing (one tag per role, and a role byte):
 *   leaf  = sha256(0x00 || "klickymart/snapshot/v1/leaf" || 0x00 || utf8(d) || 0x00 || raw_sha256[32])
 *   node  = sha256(0x01 || "klickymart/snapshot/v1/node" || left[32] || right[32])
 *   empty = sha256(0x02 || "klickymart/snapshot/v1/empty")                       (root of zero leaves)
 *   digest = sha256(0x03 || "klickymart/snapshot/v1/digest" || u64be(leaf_count) || root[32])  = snapshot_digest
 * Odd node at the end of a level is promoted unchanged (never duplicated, so no CVE-2012-2459-style twin trees);
 * the leaf count is bound into the digest. A proof is the sibling path from leaf to root. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./endpoint-binding";

const T = (s: string) => utf8ToBytes(`klickymart/snapshot/v1/${s}`);
const TL = T("leaf"), TN = T("node"), TE = T("empty"), TD = T("digest");
const B = (n: number) => new Uint8Array([n]);
const HEX64 = /^[0-9a-f]{64}$/;

export interface LeafInput { d: string; raw_sha256: string }
export interface MerkleProof { v: 1; d: string; raw_sha256: string; leaf_index: number; leaf_count: number; path: { side: "L" | "R"; hash: string }[]; root: string; snapshot_digest: string }

export function leafHash(l: LeafInput): string {
  if (typeof l.d !== "string" || !l.d || l.d.includes("\u0000")) throw new Error("leaf: d required");
  if (typeof l.raw_sha256 !== "string" || !HEX64.test(l.raw_sha256)) throw new Error("leaf: raw_sha256 must be 64 lowercase hex");
  return bytesToHex(sha256(concatBytes(B(0), TL, B(0), utf8ToBytes(l.d), B(0), hexToBytes(l.raw_sha256))));
}
export const nodeHash = (l: string, r: string) => bytesToHex(sha256(concatBytes(B(1), TN, hexToBytes(l), hexToBytes(r))));
export const EMPTY_ROOT = bytesToHex(sha256(concatBytes(B(2), TE)));
export function digestOf(count: number, root: string): string {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("bad leaf count");
  const c = new Uint8Array(8); new DataView(c.buffer).setBigUint64(0, BigInt(count));
  return bytesToHex(sha256(concatBytes(B(3), TD, c, hexToBytes(root))));
}

/** Record → leaf input. raw is the parsed record object (or its JSON text). */
export function leafFor(d: string, raw: unknown): LeafInput {
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return { d, raw_sha256: bytesToHex(sha256(utf8ToBytes(canonicalJson(obj)))) };
}

export function sortLeaves(leaves: LeafInput[]): LeafInput[] {
  const s = [...leaves].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  for (let i = 1; i < s.length; i++) if (s[i]!.d === s[i - 1]!.d) throw new Error(`duplicate leaf d: ${s[i]!.d}`);
  return s;
}

/** All levels, bottom (leaf hashes) to top (root). Input must already be sorted (use sortLeaves). */
export function buildLevels(sorted: LeafInput[]): string[][] {
  if (!sorted.length) return [];
  const levels: string[][] = [sorted.map(leafHash)];
  while (levels[levels.length - 1]!.length > 1) {
    const cur = levels[levels.length - 1]!, next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeHash(cur[i]!, cur[i + 1]!) : cur[i]!);
    levels.push(next);
  }
  return levels;
}
export const rootOf = (levels: string[][]) => (levels.length ? levels[levels.length - 1]![0]! : EMPTY_ROOT);

/** Which (level, index) nodes a proof for leaf i needs; promoted levels contribute nothing. */
export function proofPositions(i: number, count: number): { level: number; idx: number; side: "L" | "R" }[] {
  const out: { level: number; idx: number; side: "L" | "R" }[] = [];
  let n = count, level = 0;
  while (n > 1) {
    const sib = i ^ 1;
    if (sib < n) out.push({ level, idx: sib, side: sib < i ? "L" : "R" });
    i >>= 1; n = Math.ceil(n / 2); level++;
  }
  return out;
}

export function proofFromLevels(levels: string[][], sorted: LeafInput[], i: number): MerkleProof {
  const count = sorted.length;
  if (!Number.isInteger(i) || i < 0 || i >= count) throw new Error("leaf index out of range");
  const root = rootOf(levels);
  return { v: 1, d: sorted[i]!.d, raw_sha256: sorted[i]!.raw_sha256, leaf_index: i, leaf_count: count,
    path: proofPositions(i, count).map((p) => ({ side: p.side, hash: levels[p.level]![p.idx]! })), root, snapshot_digest: digestOf(count, root) };
}

/** Verify a proof against an expected snapshot_digest (from a signed head). Every field is required; extra fields fail. */
export function verifyProof(p: unknown, expectedDigest: string): { ok: true } | { ok: false; reason: string } {
  const KEYS = ["d", "leaf_count", "leaf_index", "path", "raw_sha256", "root", "snapshot_digest", "v"];
  if (!p || typeof p !== "object") return { ok: false, reason: "proof: not an object" };
  const q = p as MerkleProof;
  if (Object.keys(q).sort().join() !== KEYS.join()) return { ok: false, reason: "proof: fields must be exactly " + KEYS.join(",") };
  if (q.v !== 1) return { ok: false, reason: "proof: v must be 1" };
  if (!HEX64.test(expectedDigest) || !HEX64.test(String(q.root)) || !HEX64.test(String(q.snapshot_digest))) return { ok: false, reason: "proof: bad hex" };
  if (!Number.isSafeInteger(q.leaf_count) || q.leaf_count < 1 || !Number.isSafeInteger(q.leaf_index) || q.leaf_index < 0 || q.leaf_index >= q.leaf_count) return { ok: false, reason: "proof: bad index/count" };
  if (!Array.isArray(q.path)) return { ok: false, reason: "proof: path must be an array" };
  const want = proofPositions(q.leaf_index, q.leaf_count);
  if (q.path.length !== want.length) return { ok: false, reason: "proof: wrong path length for index/count" };
  let h: string;
  try { h = leafHash({ d: q.d, raw_sha256: q.raw_sha256 }); } catch (e) { return { ok: false, reason: String((e as Error).message) }; }
  for (let k = 0; k < want.length; k++) {
    const s = q.path[k]!;
    if (!s || typeof s !== "object" || Object.keys(s).sort().join() !== "hash,side" || s.side !== want[k]!.side || !HEX64.test(String(s.hash))) return { ok: false, reason: `proof: bad path step ${k}` };
    h = s.side === "L" ? nodeHash(s.hash, h) : nodeHash(h, s.hash);
  }
  if (h !== q.root) return { ok: false, reason: "proof: root mismatch" };
  const dg = digestOf(q.leaf_count, q.root);
  if (dg !== q.snapshot_digest || dg !== expectedDigest) return { ok: false, reason: "proof: snapshot_digest mismatch" };
  return { ok: true };
}
