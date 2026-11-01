/**
 * M2 "open store", part 2: signed results, signed snapshot head, typed fields (v9.2 §1, build step 3), plus the reference
 * harness checks. A signature gives accountability, not truth. Results never carry a score, rank or weight.
 *
 * Signing: id = sha256(DOMAIN + "\n" + canonicalJson(payload)), BIP-340 Schnorr over id with the KlickyMart result key
 * (env KM_RESULT_SK_HEX, a wrangler secret; never logged). Key custody (M3) is being rebuilt as FROST
 * Key A + Key B certs (design doc held locally); until then results carry cert_hash = null
 * and a harness that requires one rejects them. buildResult's optional key reference + expiry cap is kept for that.
 * Switch: KM_SIGNED_RESULTS = 1|true|on enables the /open-store routes (default OFF: they do not exist; when on they 503 without a key or head).
 */
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import "./nostr-verify"; // installs noble hashes for secp
import { MARK_HASH_ONLY_OLD, applyBinding, bindingStatus, canonicalJson, evidenceEvents, hashHex, parseBinding, recentRotation, type BEv, type BindingState, type BindingStatus } from "./endpoint-binding";

export const RESULT_DOMAIN = "klickymart-result-v1";
export const HEAD_DOMAIN = "klickymart-head-v1";
export const DEFAULTS_VERSION = "v9.2-m2";
/** Starting guesses. Results and heads are short-lived; the harness clamps anything longer to its own caps. */
export const RESULT_TTL_S = 600;
/** 25 h = the daily head write + 1 h slack for cron jitter (Satoshi 2026-11-01). A missed day fails closed (503). */
export const HEAD_TTL_S = 90000;

export function signedResultsEnabled(env: { KM_SIGNED_RESULTS?: string }): boolean {
  const v = (env.KM_SIGNED_RESULTS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on"; // default OFF (Matt 2026-11-01): only an explicit on enables it
}

export type Provenance = "observed" | "store-asserted" | "harness-must-verify" | "constant";
export interface Field<T> { value: T | "unknown"; provenance: Provenance }
export interface TypedFields {
  offered_settlement_modes: Field<string[]>;
  prepay_required: Field<boolean>;
  endpoint_binding: Field<BindingStatus>;
  /** Conflict is permanent per key, so endpoint_binding stays `conflict`; this shows the latest state beside the mark. */
  current_binding: Field<BindingStatus>;
  key_first_seen: Field<number>;
  recent_rotation: Field<boolean>;
  payment_bound_to_order: Field<never>;
  settlement_mode_verified: Field<never>;
  not_payment_authorization: { value: true; provenance: "constant" };
  defaults_version: Field<string>;
  snapshot_id: Field<string>;
}
export const HARNESS_ONLY = ["payment_bound_to_order", "settlement_mode_verified"] as const;

export function typedFields(s: BindingState | null | "unknown", nowS: number, snapshotId: string): TypedFields {
  const st = bindingStatus(s, nowS);
  const rot = recentRotation(s, nowS);
  return {
    // Settlement modes are a per-order claim the harness checks (v9.2 §3), never part of the binding.
    offered_settlement_modes: { value: "unknown", provenance: "store-asserted" },
    prepay_required: { value: "unknown", provenance: "store-asserted" },
    endpoint_binding: { value: st, provenance: "observed" },
    current_binding: { value: bindingStatus(s, nowS, { ignoreConflict: true }), provenance: "observed" },
    key_first_seen: { value: s && s !== "unknown" ? s.first_seen : "unknown", provenance: "observed" },
    recent_rotation: { value: rot, provenance: "observed" },
    payment_bound_to_order: { value: "unknown", provenance: "harness-must-verify" },
    settlement_mode_verified: { value: "unknown", provenance: "harness-must-verify" },
    not_payment_authorization: { value: true, provenance: "constant" },
    defaults_version: { value: DEFAULTS_VERSION, provenance: "observed" },
    snapshot_id: { value: snapshotId, provenance: "observed" },
  };
}

/** snapshot_digest: sha256 commitment over the snapshot data, signed inside the head. null = label-only head, which is
 * never served (no digest source exists in the Worker yet; M4). */
export interface HeadPayload { type: "klickymart-head"; v: 1; snapshot_id: string; snapshot_digest: string | null; sequence: number; created_at: number; expires_at: number; prev_head: string | null;
  /** M3 (pending FROST rebuild): hash of the signing key's cert. Absent (not null) today, so M2 heads sign identically. */
  cert_hash?: string }
export interface ResultPayload {
  type: "klickymart-result"; v: 1; store_pubkey: string; nonce: string; snapshot_id: string; sequence: number;
  produced_at: number; expires_at: number; cert_hash: string | null; binding_hash: string | null;
  fields: TypedFields; raw_events: BEv[];
  /** Conflicts whose old side is hash-only (old bytes left the capped history). Weaker evidence, marked as such. */
  conflict_refs: ConflictRef[];
}
export interface ConflictRef { version: number; old_hash: string; old_id: string; old_created_at: number; new_id: string; marks: string[] }
export interface Signed<P> { payload: P; id: string; signer: string; sig: string }

const digest = (domain: string, payload: unknown) => bytesToHex(sha256(utf8ToBytes(`${domain}\n${canonicalJson(payload)}`)));
function sign<P>(domain: string, payload: P, skHex: string): Signed<P> {
  const sk = hexToBytes(skHex);
  const id = digest(domain, payload);
  return { payload, id, signer: bytesToHex(secp.schnorr.getPublicKey(sk)), sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
export function verifySig<P>(domain: string, s: Signed<P>, pinned: string): string | null {
  try {
    if (s.signer !== pinned) return "not signed by the pinned KlickyMart key";
    if (digest(domain, s.payload) !== s.id) return "id does not match payload";
    return secp.schnorr.verify(hexToBytes(s.sig), hexToBytes(s.id), hexToBytes(s.signer)) ? null : "bad signature";
  } catch { return "bad signature"; }
}

export const signHead = (p: HeadPayload, skHex: string) => sign(HEAD_DOMAIN, p, skHex);
export const signResult = (p: ResultPayload, skHex: string) => sign(RESULT_DOMAIN, p, skHex);

export function buildResult(s: BindingState | null | "unknown", storePubkey: string, nonce: string, head: HeadPayload, nowS: number, certHash: string | null = null, keyUntil?: number): ResultPayload {
  const st = s === "unknown" ? null : s;
  return {
    type: "klickymart-result", v: 1, store_pubkey: storePubkey, nonce, snapshot_id: head.snapshot_id, sequence: head.sequence,
    produced_at: nowS, expires_at: Math.min(nowS + RESULT_TTL_S, head.expires_at, keyUntil ?? Number.MAX_SAFE_INTEGER), cert_hash: certHash,
    binding_hash: st?.latest ? hashHex(st.latest.content) : null, fields: typedFields(s, nowS, head.snapshot_id), raw_events: evidenceEvents(st),
    conflict_refs: (st?.conflicts ?? []).filter((c) => c.old_ref).map((c) => ({ version: c.old_ref!.version, old_hash: c.old_ref!.hash, old_id: c.old_ref!.id, old_created_at: c.old_ref!.created_at, new_id: c.events[0]!.id, marks: [...c.marks] })),
  };
}

// ---------------- Reference harness (what a buyer's wallet checks; KlickyMart never decides payment) ----------------

export interface HarnessOpts {
  pinned: string;                 // KlickyMart result key, pinned by the harness (TOFU cross-check is M3)
  nonce: string;                  // the nonce this harness sent
  nowS: number;                   // harness's own clock
  highWater: number;              // highest sequence seen (stored atomically by the harness); -1 = none
  maxAgeS?: number;               // user-set max age of a result
  skewS?: number;
  resultTtlCapS?: number;
  headTtlCapS?: number;
  requireCertHash?: boolean;  // M3; off until the key lifecycle exists
}
export type HarnessVerdict = { ok: true; acceptUntil: number; status: BindingStatus; marks?: string[] } | { ok: false; reason: string };

export function verifyResult(res: Signed<ResultPayload>, head: Signed<HeadPayload>, o: HarnessOpts): HarnessVerdict {
  const S = o.skewS ?? 60, maxAge = o.maxAgeS ?? 900, rCap = o.resultTtlCapS ?? RESULT_TTL_S, hCap = o.headTtlCapS ?? HEAD_TTL_S;
  const he = verifySig(HEAD_DOMAIN, head, o.pinned); if (he) return { ok: false, reason: `head: ${he}` };
  const h = head.payload;
  if (h.type !== "klickymart-head" || !Number.isSafeInteger(h.sequence) || h.sequence < 0) return { ok: false, reason: "head: malformed" };
  if (typeof h.snapshot_digest !== "string" || !/^[0-9a-f]{64}$/.test(h.snapshot_digest)) return { ok: false, reason: "head: no snapshot_digest (label-only head)" };
  if (h.created_at > o.nowS + S) return { ok: false, reason: "head: future-dated" };
  const headUntil = Math.min(h.expires_at, h.created_at + hCap); // future-dated expires_at is clamped
  if (o.nowS > headUntil) return { ok: false, reason: "head: expired" };
  if (h.sequence < o.highWater) return { ok: false, reason: "head: sequence below high-water (rollback)" };
  const re = verifySig(RESULT_DOMAIN, res, o.pinned); if (re) return { ok: false, reason: `result: ${re}` };
  const r = res.payload;
  if (r.type !== "klickymart-result") return { ok: false, reason: "result: malformed" };
  if (r.nonce !== o.nonce) return { ok: false, reason: "result: nonce mismatch (replay?)" };
  if (r.snapshot_id !== h.snapshot_id || r.sequence !== h.sequence) return { ok: false, reason: "result: not bound to this head" };
  if (r.produced_at > o.nowS + S) return { ok: false, reason: "result: future-dated" };
  if (o.nowS - r.produced_at > maxAge) return { ok: false, reason: "result: stale (older than max age)" };
  const resUntil = Math.min(r.expires_at, r.produced_at + rCap);
  if (o.nowS > resUntil) return { ok: false, reason: "result: expired" };
  if (o.requireCertHash && !r.cert_hash) return { ok: false, reason: "result: no cert hash" };
  for (const k of HARNESS_ONLY) if (r.fields?.[k]?.value !== "unknown") return { ok: false, reason: `result: harness-only field ${k} not unknown` };
  for (const [k, f] of Object.entries(r.fields ?? {})) if (!f || typeof f !== "object" || !("provenance" in f)) return { ok: false, reason: `result: field ${k} has no provenance` };
  // Re-verify the raw events: replay them from scratch; the claimed status must be what the evidence supports now.
  // Hash-only conflicts: the new side must be a valid event from the store key, same version, different hash.
  const marks: string[] = [];
  const refNew = new Set<string>();
  for (const cr of r.conflict_refs ?? []) {
    const nev = (r.raw_events ?? []).find((e) => e.id === cr.new_id);
    if (!nev || nev.pubkey !== r.store_pubkey) return { ok: false, reason: "result: conflict_ref new event missing" };
    const p = parseBinding(nev);
    if (!p.ok || p.value.c.revoked || p.value.c.version !== cr.version || p.value.hash === cr.old_hash) return { ok: false, reason: "result: conflict_ref does not show a conflict" };
    if (!cr.marks.includes(MARK_HASH_ONLY_OLD)) return { ok: false, reason: "result: conflict_ref not marked as hash-only evidence" };
    refNew.add(nev.id); if (!marks.includes(MARK_HASH_ONLY_OLD)) marks.push(MARK_HASH_ONLY_OLD);
  }
  let st: BindingState | undefined;
  for (const ev of [...(r.raw_events ?? [])].filter((e) => !refNew.has(e.id)).sort((a, b) => a.created_at - b.created_at)) {
    if (ev.pubkey !== r.store_pubkey) return { ok: false, reason: "result: raw event from another key" };
    const p = parseBinding(ev); if (!p.ok) return { ok: false, reason: `result: raw event invalid (${p.reason})` };
    st = applyBinding(st, ev, o.nowS).state;
  }
  const claimed = r.fields.endpoint_binding.value;
  const evidence = refNew.size && !(st?.revoked) ? "conflict" : bindingStatus(st ?? null, o.nowS);
  let status: BindingStatus = claimed as BindingStatus;
  if (claimed === "matches_observed_binding" || claimed === "url_only") {
    if (evidence !== claimed) return { ok: false, reason: `result: claims ${claimed} but raw events say ${evidence}` };
    if (!st?.latest || hashHex(st.latest.content) !== r.binding_hash) return { ok: false, reason: "result: binding_hash does not match raw events" };
  } else if (evidence === "revoked" || evidence === "conflict") status = evidence; // stronger negative evidence wins
  const cur = r.fields.current_binding?.value;
  if (cur === "matches_observed_binding" || cur === "url_only") {
    const curEv = bindingStatus(st ?? null, o.nowS, { ignoreConflict: true });
    if (curEv !== cur) return { ok: false, reason: `result: current_binding claims ${cur} but raw events say ${curEv}` };
  }
  let until = Math.min(headUntil, resUntil);
  if (st?.latest && status === "matches_observed_binding") until = Math.min(until, (JSON.parse(st.latest.content) as { expires_at: number }).expires_at);
  return { ok: true, acceptUntil: until, status, ...(marks.length ? { marks } : {}) };
}

/** Liveness (v9.2 §1): cached unexpired state may be used; after that, KlickyMart-dependent payments fail closed;
 * reading relays directly is opt-in only. */
export function paymentGate(cached: { acceptUntil: number } | null, nowS: number, relayOnlyOptIn = false): "use_cache" | "relay_only" | "fail_closed" {
  if (cached && nowS <= cached.acceptUntil) return "use_cache";
  return relayOnlyOptIn ? "relay_only" : "fail_closed";
}

// ---------------- Worker side ----------------

export async function latestHead(db: D1Database, nowS: number): Promise<HeadPayload | null> {
  try {
    const r = await db.prepare("SELECT sequence, snapshot_id, snapshot_digest, created_at, prev_head FROM snapshot_heads ORDER BY sequence DESC LIMIT 1").first<{ sequence: number; snapshot_id: string; snapshot_digest: string | null; created_at: number; prev_head: string | null }>();
    if (!r) return null;
    const exp = r.created_at + HEAD_TTL_S;
    if (exp <= nowS) return null; // never serve an expired head; the snapshot step (M4) must publish a fresh one
    return { type: "klickymart-head", v: 1, snapshot_id: r.snapshot_id, snapshot_digest: r.snapshot_digest ?? null, sequence: r.sequence, created_at: r.created_at, expires_at: exp, prev_head: r.prev_head };
  } catch { return null; }
}

/** Snapshot step helper. M2: the daily cron calls it via writeDailyHead (open-store.ts) when KM_SIGNED_RESULTS is on; M4 owns the real step. Sequence strictly increases; never reused. */
export async function recordSnapshotHead(db: D1Database, snapshotId: string, nowS: number, snapshotDigest: string | null = null): Promise<number> {
  const last = await db.prepare("SELECT sequence, snapshot_id FROM snapshot_heads ORDER BY sequence DESC LIMIT 1").first<{ sequence: number; snapshot_id: string }>();
  const seq = (last?.sequence ?? -1) + 1;
  if (!Number.isSafeInteger(seq)) throw new Error("sequence overflow");
  await db.prepare("INSERT INTO snapshot_heads (sequence, snapshot_id, snapshot_digest, created_at, prev_head) VALUES (?,?,?,?,?)").bind(seq, snapshotId, snapshotDigest, nowS, last ? `${last.sequence}:${last.snapshot_id}` : null).run();
  return seq;
}
