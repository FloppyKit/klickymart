/** M2 open-store routes. GET /open-store/head and GET /open-store/binding?pubkey=<64 hex>&nonce=<8-128 [A-Za-z0-9_-]>.
 * Every response body is signed; the harness re-verifies the raw events it carries. 503 (unsigned, no-store) without a
 * signing key or a fresh snapshot head: nothing is served that the harness could mistake for a signed fact. */
import type { Env } from "./router";
import { loadBindingState } from "./endpoint-binding";
import { buildResult, latestHead, signHead, signResult } from "./signed-result";
export { signedResultsEnabled } from "./signed-result";
import { recordSnapshotHead, signedResultsEnabled as _sre } from "./signed-result";

const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const unavailable = (why: string) => Response.json({ ok: false, error: "unavailable", reason: why }, { status: 503, headers: H });

export async function openStoreRoute(path: string, url: URL, env: Env): Promise<Response> {
  if (path !== "/open-store/head" && path !== "/open-store/binding") return Response.json({ ok: false, error: "not found" }, { status: 404, headers: H });
  const sk = env.KM_RESULT_SK_HEX;
  if (!sk || !/^[0-9a-f]{64}$/.test(sk)) return unavailable("no result-signing key configured");
  if (!env.DB) return unavailable("no database");
  const nowS = Math.floor(Date.now() / 1000);
  const head = await latestHead(env.DB, nowS);
  if (!head) return unavailable("no fresh snapshot head");
  const sh = signHead(head, sk);
  if (path === "/open-store/head") return Response.json(sh, { headers: H });
  const pubkey = url.searchParams.get("pubkey") ?? "";
  const nonce = url.searchParams.get("nonce") ?? "";
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return Response.json({ ok: false, error: "pubkey must be 64 lowercase hex" }, { status: 400, headers: H });
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) return Response.json({ ok: false, error: "nonce required (8-128 chars A-Za-z0-9_-)" }, { status: 400, headers: H });
  const state = await loadBindingState(env.DB, pubkey);
  return Response.json({ head: sh, result: signResult(buildResult(state, pubkey, nonce, head, nowS), sk) }, { headers: H });
}

/** Daily snapshot step (M2): called once from the existing daily cron after relay catch-up. Writes one head row only when
 * KM_SIGNED_RESULTS is on; otherwise does nothing. snapshot_id = "<snapshot data version>@<cron unix seconds>": the spec
 * does not yet define what a head commits to, so this is a LABEL (which data version + when), not a content commitment
 * (no Merkle root / digest). Flagged for Satoshi; M4 owns the real snapshot step. */
export async function writeDailyHead(env: { DB?: D1Database; KM_SIGNED_RESULTS?: string }, snapshotVersion: string, nowS: number): Promise<number | null> {
  if (!_sre(env) || !env.DB) return null;
  try { return await recordSnapshotHead(env.DB, `${snapshotVersion}@${nowS}`, nowS); } catch { return null; }
}
