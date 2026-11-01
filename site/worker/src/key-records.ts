/** M3 key records (v1, single key). The one result-signing key (KM_RESULT_SK_HEX) gets three typed, signed records:
 * pin (self-signed), rotate (signed by OLD and NEW key) and revoke (signed by the revoked key; final).
 * id = sha256(JCS(body)) (content address). Each signature is BIP-340 over sha256(TAG + "\n" + JCS(body)), one tag per
 * type. canonicalJson is RFC 8785 for the value set used here (sorted UTF-16 keys, ES number/string serialization).
 * Fail closed: any bad record, broken prev link, fork (two rotates from one prev) or unknown type => error.
 * Accepted residual: whoever holds the current key can rotate to a key of their choice. The kill switch is a second
 * rotate from the same prev (fork => fail closed), plus revoke. FROST is planned later, via the same rotate step.
 * Observation only: no scorer or ranking code reads km_key_records. */
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import "./nostr-verify";
import { canonicalJson } from "./endpoint-binding";
import { HEAD_DOMAIN, RESULT_DOMAIN, verifySig, type HeadPayload, type ResultPayload, type Signed } from "./signed-result";

export const PIN_TAG = "klickymart-key-pin-v1";
export const ROTATE_TAG = "klickymart-key-rotate-v1";
export const REVOKE_TAG = "klickymart-key-revoke-v1";

export interface PinBody { type: "km-key-pin"; v: 1; pubkey: string; created_at: number }
export interface RotateBody { type: "km-key-rotate"; v: 1; old_pubkey: string; new_pubkey: string; prev: string; last_good_head: string; created_at: number }
export interface RevokeBody { type: "km-key-revoke"; v: 1; pubkey: string; last_good_head: string; created_at: number }
export type PinRecord = { id: string; body: PinBody; sig: string };
export type RotateRecord = { id: string; body: RotateBody; sig_old: string; sig_new: string };
export type RevokeRecord = { id: string; body: RevokeBody; sig: string };
export type KeyRecord = PinRecord | RotateRecord | RevokeRecord;

const HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/;
const isTs = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const FIELDS: Record<string, { tag: string; body: Record<string, (v: unknown) => boolean>; sigs: string[] }> = {
  "km-key-pin": { tag: PIN_TAG, sigs: ["sig"], body: { type: () => true, v: (x) => x === 1, pubkey: (x) => typeof x === "string" && HEX64.test(x), created_at: isTs } },
  "km-key-rotate": { tag: ROTATE_TAG, sigs: ["sig_old", "sig_new"], body: { type: () => true, v: (x) => x === 1, old_pubkey: (x) => typeof x === "string" && HEX64.test(x), new_pubkey: (x) => typeof x === "string" && HEX64.test(x), prev: (x) => typeof x === "string" && HEX64.test(x), last_good_head: (x) => typeof x === "string" && HEX64.test(x), created_at: isTs } },
  "km-key-revoke": { tag: REVOKE_TAG, sigs: ["sig"], body: { type: () => true, v: (x) => x === 1, pubkey: (x) => typeof x === "string" && HEX64.test(x), last_good_head: (x) => typeof x === "string" && HEX64.test(x), created_at: isTs } },
};

export const recordId = (body: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(body))));
const msg = (tag: string, body: unknown) => sha256(utf8ToBytes(`${tag}\n${canonicalJson(body)}`));
const schnorrSign = (tag: string, body: unknown, sk: Uint8Array) => bytesToHex(secp.schnorr.sign(msg(tag, body), sk));
const schnorrOk = (tag: string, body: unknown, sig: string, pub: string) => { try { return secp.schnorr.verify(hexToBytes(sig), msg(tag, body), hexToBytes(pub)); } catch { return false; } };
const pubOf = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));

export function makePin(sk: Uint8Array, created_at: number): PinRecord {
  const body: PinBody = { type: "km-key-pin", v: 1, pubkey: pubOf(sk), created_at };
  return { id: recordId(body), body, sig: schnorrSign(PIN_TAG, body, sk) };
}
export function makeRotate(oldSk: Uint8Array, newSk: Uint8Array, prev: string, last_good_head: string, created_at: number): RotateRecord {
  const body: RotateBody = { type: "km-key-rotate", v: 1, old_pubkey: pubOf(oldSk), new_pubkey: pubOf(newSk), prev, last_good_head, created_at };
  return { id: recordId(body), body, sig_old: schnorrSign(ROTATE_TAG, body, oldSk), sig_new: schnorrSign(ROTATE_TAG, body, newSk) };
}
export function makeRevoke(sk: Uint8Array, last_good_head: string, created_at: number): RevokeRecord {
  const body: RevokeBody = { type: "km-key-revoke", v: 1, pubkey: pubOf(sk), last_good_head, created_at };
  return { id: recordId(body), body, sig: schnorrSign(REVOKE_TAG, body, sk) };
}

/** Shape + id + signature check of one record. Fixed required field set; unknown fields rejected (envelope and body). */
export function checkRecord(r: unknown): { ok: true; rec: KeyRecord } | { ok: false; error: string } {
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, error: "record is not an object" };
  const o = r as Record<string, unknown>;
  const b = o.body as Record<string, unknown> | undefined;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "record has no body" };
  const spec = FIELDS[b.type as string];
  if (!spec) return { ok: false, error: `unknown type ${String(b.type)}` };
  const env = ["id", "body", ...spec.sigs];
  for (const k of Object.keys(o)) if (!env.includes(k)) return { ok: false, error: `unknown field ${k}` };
  for (const k of Object.keys(b)) if (!(k in spec.body)) return { ok: false, error: `unknown field body.${k}` };
  for (const [k, ok] of Object.entries(spec.body)) if (!(k in b) || !ok(b[k])) return { ok: false, error: `missing or bad body.${k}` };
  for (const s of spec.sigs) if (typeof o[s] !== "string" || !HEX128.test(o[s] as string)) return { ok: false, error: `missing or bad ${s}` };
  if (o.id !== recordId(b)) return { ok: false, error: "id does not match body" };
  if (b.type === "km-key-rotate") {
    if (b.old_pubkey === b.new_pubkey) return { ok: false, error: "rotate to the same key" };
    if (!schnorrOk(spec.tag, b, o.sig_old as string, b.old_pubkey as string)) return { ok: false, error: "bad sig_old" };
    if (!schnorrOk(spec.tag, b, o.sig_new as string, b.new_pubkey as string)) return { ok: false, error: "bad sig_new" };
  } else if (!schnorrOk(spec.tag, b, o.sig as string, b.pubkey as string)) return { ok: false, error: "bad sig" };
  return { ok: true, rec: o as unknown as KeyRecord };
}

export interface ChainLink { pubkey: string; cert_hash: string; retired_after?: string }
export type KeyState =
  | { ok: true; current: string; status: "active" | "revoked"; cert_hash: string; chain: ChainLink[]; revoked: Record<string, string[]> }
  | { ok: false; error: string };

/** Pure verifier over the full record list (order-independent). */
export function verifyKeyRecords(records: unknown[]): KeyState {
  const recs: KeyRecord[] = [];
  for (const r of records) { const c = checkRecord(r); if (!c.ok) return { ok: false, error: c.error }; recs.push(c.rec); }
  const pins = recs.filter((r): r is PinRecord => r.body.type === "km-key-pin");
  if (pins.length !== 1) return { ok: false, error: pins.length ? "more than one pin" : "no pin" };
  const rotates = recs.filter((r): r is RotateRecord => r.body.type === "km-key-rotate");
  const byPrev = new Map<string, RotateRecord>();
  for (const r of rotates) { if (byPrev.has(r.body.prev) && byPrev.get(r.body.prev)!.id !== r.id) return { ok: false, error: `fork: two rotates from prev ${r.body.prev}` }; byPrev.set(r.body.prev, r); }
  const chain: ChainLink[] = [{ pubkey: pins[0]!.body.pubkey, cert_hash: pins[0]!.id }];
  const seen = new Set<string>([chain[0]!.pubkey]);
  let used = 0;
  for (let tip = chain[0]!; byPrev.has(tip.cert_hash);) {
    const r = byPrev.get(tip.cert_hash)!;
    if (r.body.old_pubkey !== tip.pubkey) return { ok: false, error: "rotate old_pubkey is not the key it follows" };
    if (seen.has(r.body.new_pubkey)) return { ok: false, error: "rotate back to an earlier key" };
    tip.retired_after = r.body.last_good_head;
    const next = { pubkey: r.body.new_pubkey, cert_hash: r.id }; chain.push(next); seen.add(next.pubkey); used++; tip = next;
  }
  if (used !== new Set(rotates.map((r) => r.id)).size) return { ok: false, error: "broken prev link: rotate not on the chain" };
  const revoked: Record<string, string[]> = {};
  for (const r of recs) if (r.body.type === "km-key-revoke") {
    if (!seen.has(r.body.pubkey)) return { ok: false, error: "revoke for a key not on the chain" };
    (revoked[r.body.pubkey] ??= []).includes(r.body.last_good_head) || revoked[r.body.pubkey]!.push(r.body.last_good_head);
  }
  const cur = chain[chain.length - 1]!;
  return { ok: true, current: cur.pubkey, status: revoked[cur.pubkey] ? "revoked" : "active", cert_hash: cur.cert_hash, chain, revoked };
}

export type ResultClass = { class: "ok" | "signed_then_revoked" | "unknown_key"; reason?: string };

/** Classify a signed result against the records and the heads the caller holds. A key's cutoff is each revoke's
 * last_good_head and (if rotated away) the rotate's last_good_head; a result is ok only if its head is the cutoff head or
 * provably before it in the prev-chain, else signed_then_revoked. Anything unverifiable => unknown_key. */
export function classifyResult(res: Signed<ResultPayload>, head: Signed<HeadPayload>, records: unknown[], heads: Signed<HeadPayload>[]): ResultClass {
  const st = verifyKeyRecords(records);
  if (!st.ok) return { class: "unknown_key", reason: `records: ${st.error}` };
  const link = st.chain.find((l) => l.pubkey === res.signer);
  if (!link) return { class: "unknown_key", reason: "signer not on the key chain" };
  if (verifySig(RESULT_DOMAIN, res, link.pubkey) || verifySig(HEAD_DOMAIN, head, link.pubkey)) return { class: "unknown_key", reason: "bad signature" };
  if (res.payload.snapshot_id !== head.payload.snapshot_id || res.payload.sequence !== head.payload.sequence) return { class: "unknown_key", reason: "result not bound to head" };
  if (res.payload.cert_hash != null && res.payload.cert_hash !== link.cert_hash) return { class: "unknown_key", reason: "cert_hash does not authorize signer" };
  const cutoffs = [...(st.revoked[link.pubkey] ?? []), ...(link.retired_after ? [link.retired_after] : [])];
  if (!cutoffs.length) return { class: "ok" };
  // ok only if this head is the cutoff head or one of its ancestors in the prev-chain ("<sequence>:<snapshot_id>").
  const byId = new Map(heads.map((h) => [h.id, h]));
  const byLabel = new Map(heads.map((h) => [`${h.payload.sequence}:${h.payload.snapshot_id}`, h]));
  const onChain = new Set(st.chain.map((l) => l.pubkey));
  for (const c of cutoffs) {
    let h = byId.get(c), found = false;
    for (let n = 0; h && n <= heads.length; n++) {
      if (!onChain.has(h.signer) || verifySig(HEAD_DOMAIN, h, h.signer)) break; // unverifiable link: stop (fail closed)
      if (h.id === head.id) { found = true; break; }
      h = h.payload.prev_head ? byLabel.get(h.payload.prev_head) : undefined;
    }
    if (!found) return { class: "signed_then_revoked", reason: "head is not at or before last_good_head in the prev-chain" };
  }
  return { class: "ok" };
}

// ---------------- Worker side (append-only table; flag KM_KEY_RECORDS, default off) ----------------

export function keyRecordsEnabled(env: { KM_KEY_RECORDS?: string }): boolean {
  const v = (env.KM_KEY_RECORDS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}
export async function loadKeyRecords(db: D1Database): Promise<KeyRecord[]> {
  const r = await db.prepare("SELECT body FROM km_key_records ORDER BY created_at, rowid").all<{ body: string }>();
  return (r.results ?? []).map((x) => JSON.parse(x.body) as KeyRecord);
}
/** Appends one record if it is valid alone AND the resulting set still verifies (a fork is refused here, but the verifier
 * fails closed on one anyway, e.g. if two rows were inserted out of band). */
export async function appendKeyRecord(db: D1Database, rec: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = checkRecord(rec); if (!c.ok) return c;
  const all = verifyKeyRecords([...(await loadKeyRecords(db)), c.rec]); if (!all.ok) return { ok: false, error: all.error };
  await db.prepare("INSERT INTO km_key_records (id, type, body, created_at) VALUES (?,?,?,?)").bind(c.rec.id, c.rec.body.type, JSON.stringify(c.rec), c.rec.body.created_at).run();
  return { ok: true };
}
