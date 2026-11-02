/** M4 S2: compute the snapshot Merkle tree once per daily head and store it (append-only) so proofs are read, not
 * recomputed, per request. Flag KM_SNAPSHOT_DIGEST (default OFF; only 1/true/on enables). */
import { buildLevels, digestOf, leafFor, proofPositions, rootOf, sortLeaves, type LeafInput, type MerkleProof } from "./merkle";

export function snapshotDigestEnabled(env: { KM_SNAPSHOT_DIGEST?: string }): boolean {
  const v = (env.KM_SNAPSHOT_DIGEST ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}
/** Budget guard: at most this many node+leaf rows per daily head (≤ 20% of D1's 100k writes/day free tier). */
export const MAX_TREE_ROWS = 20_000;

export interface Tree { sorted: LeafInput[]; levels: string[][]; root: string; digest: string; count: number }
export function treeFor(rows: { d: string; raw_json: string }[]): Tree {
  const sorted = sortLeaves(rows.map((r) => leafFor(r.d, r.raw_json)));
  const levels = buildLevels(sorted);
  const root = rootOf(levels);
  return { sorted, levels, root, digest: digestOf(sorted.length, root), count: sorted.length };
}
export const treeRowCount = (t: Tree) => t.levels.reduce((n, l) => n + l.length, 0) + t.count;

/** INSERT statements for the tree rows of head `seq` (run them in the same db.batch as the head insert: D1 batches are atomic). */
export function treeStatements(db: D1Database, seq: number, t: Tree): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const CH = 25; // 4 params per row: stays under D1's 100 bound parameters per statement
  const nodes: [number, number, string][] = [];
  t.levels.forEach((l, level) => l.forEach((h, idx) => nodes.push([level, idx, h])));
  for (let i = 0; i < nodes.length; i += CH) {
    const c = nodes.slice(i, i + CH);
    stmts.push(db.prepare(`INSERT INTO snapshot_nodes (sequence, level, idx, hash) VALUES ${c.map(() => "(?,?,?,?)").join(",")}`).bind(...c.flatMap(([lv, ix, h]) => [seq, lv, ix, h])));
  }
  for (let i = 0; i < t.sorted.length; i += CH) {
    const c = t.sorted.slice(i, i + CH);
    stmts.push(db.prepare(`INSERT INTO snapshot_leaves (sequence, idx, d, raw_sha256) VALUES ${c.map(() => "(?,?,?,?)").join(",")}`).bind(...c.flatMap((l, k) => [seq, i + k, l.d, l.raw_sha256])));
  }
  return stmts;
}

/** Proof for domain d in head `seq`, from stored rows only (≤ log2(n)+2 row reads). null = not in that snapshot. */
export async function loadProof(db: D1Database, seq: number, d: string): Promise<MerkleProof | null> {
  const head = await db.prepare("SELECT snapshot_digest, merkle_leaf_count FROM snapshot_heads WHERE sequence = ?").bind(seq).first<{ snapshot_digest: string | null; merkle_leaf_count: number | null }>();
  if (!head?.snapshot_digest || !head.merkle_leaf_count) return null;
  const leaf = await db.prepare("SELECT idx, raw_sha256 FROM snapshot_leaves WHERE sequence = ? AND d = ?").bind(seq, d).first<{ idx: number; raw_sha256: string }>();
  if (!leaf) return null;
  const count = head.merkle_leaf_count;
  const pos = proofPositions(leaf.idx, count);
  let levels = 0; for (let n = count; n > 1; n = Math.ceil(n / 2)) levels++;
  const want = [...pos.map((p) => [p.level, p.idx] as const), [levels, 0] as const];
  const { results } = await db.prepare(`SELECT level, idx, hash FROM snapshot_nodes WHERE sequence = ? AND (${want.map(() => "(level = ? AND idx = ?)").join(" OR ")})`).bind(seq, ...want.flat()).all<{ level: number; idx: number; hash: string }>();
  const get = (lv: number, ix: number) => results?.find((r) => r.level === lv && r.idx === ix)?.hash;
  const root = get(levels, 0);
  if (!root) return null;
  const path = pos.map((p) => ({ side: p.side, hash: get(p.level, p.idx)! }));
  if (path.some((s) => !s.hash)) return null;
  return { v: 1, d, raw_sha256: leaf.raw_sha256, leaf_index: leaf.idx, leaf_count: count, path, root, snapshot_digest: head.snapshot_digest };
}
