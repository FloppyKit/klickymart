/** M2 open-store routes. GET /open-store/head and GET /open-store/binding?pubkey=<64 hex>&nonce=<8-128 [A-Za-z0-9_-]>.
 * Every response body is signed; the harness re-verifies the raw events it carries. 503 (unsigned, no-store) without a
 * signing key or a fresh snapshot head: nothing is served that the harness could mistake for a signed fact. */
import type { Env } from "./router";
import { loadBindingState } from "./endpoint-binding";
import { buildResult, latestHead, signHead, signResult } from "./signed-result";
import { cronHandover, currentStatement, exportKeyState, keyLifecycleEnabled, loadKeyState, pubFromSkHex, statementStatus } from "./key-lifecycle";
export { signedResultsEnabled } from "./signed-result";
import { recordSnapshotHead, signedResultsEnabled as _sre } from "./signed-result";

const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const unavailable = (why: string) => Response.json({ ok: false, error: "unavailable", reason: why }, { status: 503, headers: H });

export async function openStoreRoute(path: string, url: URL, env: Env): Promise<Response> {
  const lifecycle = keyLifecycleEnabled(env);
  if (path === "/open-store/keys" && lifecycle) return keysRoute(env);
  if (path !== "/open-store/head" && path !== "/open-store/binding") return Response.json({ ok: false, error: "not found" }, { status: 404, headers: H });
  let sk = env.KM_RESULT_SK_HEX;
  if (!sk || !/^[0-9a-f]{64}$/.test(sk)) return unavailable("no result-signing key configured");
  if (!env.DB) return unavailable("no database");
  const nowS = Math.floor(Date.now() / 1000);
  const head = await latestHead(env.DB, nowS);
  if (!head) return unavailable("no fresh snapshot head");
  // Guard (Satoshi 2026-11-01): a label-only head must never be public. Until the snapshot step can commit to the data
  // (snapshot_digest; M4), KM_SIGNED_RESULTS=on still serves nothing.
  if (!head.snapshot_digest) return unavailable("head has no snapshot_digest: label-only heads are not served (digest pending M4)");
  // M3 (KM_KEY_LIFECYCLE on): sign only under a current, unrevoked, unexpired key statement whose key IS this signing
  // key; the head and every result name that statement's hash. Anything else fails closed (503).
  let ksh: string | null = null, keyUntil: number | undefined;
  if (lifecycle) {
    const root = (env.KM_KEY_ROOT ?? "").trim();
    if (!/^[0-9a-f]{64}$/.test(root)) return unavailable("key lifecycle on but no KM_KEY_ROOT pinned");
    const ks = await loadKeyState(env.DB, root);
    if (!ks) return unavailable("key records unreadable");
    if (ks.compromised) return unavailable("key lineage compromised");
    const cap = env.KM_KEY_TTL_CAP_S; // may only LOWER HARD_MAX_S
    const cur = currentStatement(ks, nowS, { ttlCapS: cap as never });
    if (!cur) return unavailable("no current key statement (expired, revoked or missing)");
    // Sign with whichever loaded key the current statement names (after a cron handover that is KM_RESULT_SK_NEXT_HEX).
    const pick = [env.KM_RESULT_SK_HEX, env.KM_RESULT_SK_NEXT_HEX].find((k) => pubFromSkHex(k) === cur.payload.key);
    if (!pick) return unavailable("signing key is not the key named by the current statement");
    sk = pick;
    ksh = cur.hash; keyUntil = statementStatus(ks, cur.hash, nowS, { ttlCapS: cap as never }).until;
    head.key_statement_hash = ksh;
    head.expires_at = Math.min(head.expires_at, keyUntil ?? head.expires_at);
  }
  const sh = signHead(head, sk);
  if (path === "/open-store/head") return Response.json(sh, { headers: H });
  const pubkey = url.searchParams.get("pubkey") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return Response.json({ ok: false, error: "pubkey must be 64 lowercase hex" }, { status: 400, headers: H });
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) return Response.json({ ok: false, error: "nonce required (8-128 chars A-Za-z0-9_-)" }, { status: 400, headers: H });
  const state = await loadBindingState(env.DB, pubkey);
  return Response.json({ head: sh, result: signResult(buildResult(state, pubkey, nonce, head, nowS, ksh, keyUntil), sk) }, { headers: H });
}

/** Daily snapshot step (M2): called once from the existing daily cron after relay catch-up. Writes one head row only when
 * KM_SIGNED_RESULTS is on; otherwise does nothing. snapshot_id = "<snapshot data version>@<cron unix seconds>": the spec
 * does not yet define what a head commits to, so this is a LABEL (which data version + when), not a content commitment
 * (no Merkle root / digest). Flagged for Satoshi; M4 owns the real snapshot step. */
export async function writeDailyHead(env: { DB?: D1Database; KM_SIGNED_RESULTS?: string; KM_KEY_LIFECYCLE?: string; KM_KEY_ROOT?: string; KM_RESULT_SK_NEXT_HEX?: string; KM_KEY_TTL_CAP_S?: string }, snapshotVersion: string, nowS: number): Promise<number | null> {
  if (!_sre(env) || !env.DB) return null;
  // M3: a staged handover is promoted in this same daily run, right before the head is written (no 503 gap).
  if (keyLifecycleEnabled(env)) { try { await cronHandover(env.DB, env, nowS); } catch { /* lineage unchanged; fails closed if needed */ } }
  try { return await recordSnapshotHead(env.DB, `${snapshotVersion}@${nowS}`, nowS); } catch { return null; }
}

/** GET /open-store/keys (only when KM_SIGNED_RESULTS and KM_KEY_LIFECYCLE are both on): the pinned root and every stored
 * key record. Records are self-verifying, so the response itself is not signed; harnesses must cross-check the root on
 * a second channel (v9.2 TOFU) and keep revokes they have already seen. */
async function keysRoute(env: Env): Promise<Response> {
  const root = (env.KM_KEY_ROOT ?? "").trim();
  if (!/^[0-9a-f]{64}$/.test(root) || !env.DB) return unavailable("no KM_KEY_ROOT pinned");
  const ks = await loadKeyState(env.DB, root);
  if (!ks) return unavailable("key records unreadable");
  return new Response(exportKeyState(ks), { headers: { ...H, "Content-Type": "application/json" } });
}
