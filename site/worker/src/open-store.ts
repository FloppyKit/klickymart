/** M2 open-store routes. GET /open-store/head and GET /open-store/binding?pubkey=<64 hex>&nonce=<8-128 [A-Za-z0-9_-]>.
 * Every response body is signed; the harness re-verifies the raw events it carries. 503 (unsigned, no-store) without a
 * signing key or a fresh snapshot head: nothing is served that the harness could mistake for a signed fact. */
import type { Env } from "./router";
import { loadBindingState } from "./endpoint-binding";
import { buildResult, latestHead, signHead, signResult } from "./signed-result";
export { signedResultsEnabled } from "./signed-result";
import { recordSnapshotHead, signedResultsEnabled as _sre } from "./signed-result";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { MAX_TREE_ROWS, loadProof, snapshotDigestEnabled, treeStatements, treeFor, treeRowCount } from "./snapshot-tree";
import { keyRecordsEnabled, loadKeyRecords, verifyKeyRecords } from "./key-records";

/** M3: GET /open-store/keys (only when KM_KEY_RECORDS is on; else 404). Public records in order, no secrets. */
export async function keyRecordsRoute(env: Env): Promise<Response> {
  if (!keyRecordsEnabled(env)) return Response.json({ ok: false, error: "not found" }, { status: 404, headers: H });
  if (!env.DB) return unavailable("no database");
  const records = await loadKeyRecords(env.DB);
  const st = verifyKeyRecords(records);
  return Response.json({ records, state: st.ok ? { current: st.current, status: st.status, cert_hash: st.cert_hash } : { error: st.error } }, { headers: H });
}

const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const unavailable = (why: string) => Response.json({ ok: false, error: "unavailable", reason: why }, { status: 503, headers: H });

export async function openStoreRoute(path: string, url: URL, env: Env): Promise<Response> {
  const isProof = path === "/open-store/proof" && snapshotDigestEnabled(env);
  if (path !== "/open-store/head" && path !== "/open-store/binding" && !isProof) return Response.json({ ok: false, error: "not found" }, { status: 404, headers: H });
  const sk = env.KM_RESULT_SK_HEX;
  if (!sk || !/^[0-9a-f]{64}$/.test(sk)) return unavailable("no result-signing key configured");
  if (!env.DB) return unavailable("no database");
  const nowS = Math.floor(Date.now() / 1000);
  const head = await latestHead(env.DB, nowS);
  if (!head) return unavailable("no fresh snapshot head");
  // Guard (Satoshi 2026-11-01): a label-only head must never be public. Digest heads come from KM_SNAPSHOT_DIGEST (M4 S2).
  if (!head.snapshot_digest) return unavailable("head has no snapshot_digest: label-only heads are not served (enable KM_SNAPSHOT_DIGEST)");
  // M3: with KM_KEY_RECORDS on, the signing key must be the active current key of the records; cert_hash names its pin
  // or latest rotate. Anything else fails closed (503).
  if (keyRecordsEnabled(env)) {
    const st = verifyKeyRecords(await loadKeyRecords(env.DB));
    if (!st.ok) return unavailable(`key records do not verify: ${st.error}`);
    if (st.status !== "active" || st.current !== bytesToHex(secp.schnorr.getPublicKey(hexToBytes(sk)))) return unavailable("signing key is not the active key in the key records");
    head.cert_hash = st.cert_hash;
  }
  const sh = signHead(head, sk);
  if (path === "/open-store/head") return Response.json(sh, { headers: H });
  // M4 S2: GET /open-store/proof?d=<domain>: the signed head plus the stored inclusion proof for that record.
  if (isProof) {
    const d = (url.searchParams.get("d") ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.-]{1,253}$/.test(d)) return Response.json({ ok: false, error: "d must be a domain" }, { status: 400, headers: H });
    const proof = await loadProof(env.DB, head.sequence, d);
    if (!proof) return Response.json({ ok: false, error: "not in this snapshot (or no stored tree)" }, { status: 404, headers: H });
    return Response.json({ head: sh, proof }, { headers: H });
  }
  const pubkey = url.searchParams.get("pubkey") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return Response.json({ ok: false, error: "pubkey must be 64 lowercase hex" }, { status: 400, headers: H });
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) return Response.json({ ok: false, error: "nonce required (8-128 chars A-Za-z0-9_-)" }, { status: 400, headers: H });
  const state = await loadBindingState(env.DB, pubkey);
  return Response.json({ head: sh, result: signResult(buildResult(state, pubkey, nonce, head, nowS, head.cert_hash ?? null), sk) }, { headers: H });
}

/** Daily snapshot step. Called once from the existing daily cron after relay catch-up; writes one head row only when
 * KM_SIGNED_RESULTS is on. snapshot_id = "<snapshot data version>@<cron unix seconds>" (a label).
 * M4 S2: with KM_SNAPSHOT_DIGEST also on and the served rows given, the head carries the real snapshot_digest (Merkle
 * digest over every served record, see merkle.ts) and the tree rows (snapshot_nodes / snapshot_leaves) are written in the same atomic batch as the head, so
 * proofs are only read later. Tree over MAX_TREE_ROWS (free-tier write budget) or any error → label-only head (not served). */
export async function writeDailyHead(env: { DB?: D1Database; KM_SIGNED_RESULTS?: string; KM_SNAPSHOT_DIGEST?: string }, snapshotVersion: string, nowS: number, rows?: { d: string; raw_json: string }[]): Promise<number | null> {
  if (!_sre(env) || !env.DB) return null;
  const label = `${snapshotVersion}@${nowS}`;
  if (snapshotDigestEnabled(env) && rows) {
    try {
      const t = treeFor(rows);
      if (treeRowCount(t) <= MAX_TREE_ROWS) {
        const last = await env.DB.prepare("SELECT sequence, snapshot_id FROM snapshot_heads ORDER BY sequence DESC LIMIT 1").first<{ sequence: number; snapshot_id: string }>();
        const seq = (last?.sequence ?? -1) + 1;
        if (!Number.isSafeInteger(seq)) return null;
        // Tree rows + head in ONE atomic batch: a failed head (e.g. same-second rerun, UNIQUE snapshot_id) leaves no orphan rows.
        await env.DB.batch([...treeStatements(env.DB, seq, t),
          env.DB.prepare("INSERT INTO snapshot_heads (sequence, snapshot_id, snapshot_digest, created_at, prev_head, merkle_leaf_count) VALUES (?,?,?,?,?,?)").bind(seq, label, t.digest, nowS, last ? `${last.sequence}:${last.snapshot_id}` : null, t.count)]);
        return seq;
      }
      return await recordSnapshotHead(env.DB, label, nowS); // over budget: label-only (not served)
    } catch { return null; } // same-second rerun or write error: no head this run (never a half-written tree)
  }
  try { return await recordSnapshotHead(env.DB, label, nowS); } catch { return null; }
}
