/**
 * M3: KlickyMart signing-key lifecycle (v9.2 §1 "KlickyMart's own signing key: pre-rotation lifecycle", build step 4).
 *
 * Records (all JSON, all self-verifying; nothing here is published to Nostr):
 *  - key statement: names its key, the sha256 digest of the next key (pre-rotation, KERI-style), the hash of the previous
 *    statement, the offline revocation key, created_at and expires_at. Immutable: hash = sha256(domain + "\n" + canonical
 *    payload). Inception (seq 0) carries only the key's own signature (proof of possession). A handover (seq n+1) is
 *    valid only to the successor announced at seq n: sha256(new key) must equal the previous next_key_digest, and it
 *    carries BOTH the previous key's signature and the new key's proof of possession.
 *  - revoke: signed by the current offline revocation key; it only revokes (never certifies), names a target statement,
 *    covers that statement and every descendant, and beats any handover regardless of timestamps.
 *  - revocation-key rotation: needs BOTH the current signing key and the old revocation key.
 *
 * Harness side: the lineage and revokes are persistent, append-only state (export/import; revokes and compromise are
 * never removed, so they survive a reinstall that restores state). Two different statements at one lineage position =
 * compromised (sticky, fails closed). The first pin is TOFU cross-checked on >= 2 channels.
 *
 * Constants marked PENDING SATOSHI are conservative placeholders, not mechanism decisions.
 */
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import "./nostr-verify";
import { canonicalJson } from "./endpoint-binding";
import { verifyResult, type HarnessOpts, type HarnessVerdict, type HeadPayload, type ResultPayload, type Signed } from "./signed-result";

export const KEYSTMT_DOMAIN = "klickymart-keystmt-v1";
export const REVOKE_DOMAIN = "klickymart-keyrevoke-v1";
export const REVKEY_ROTATE_DOMAIN = "klickymart-revkey-rotate-v1";
/** Hard max lifetime of a key statement, compiled in (Satoshi final M3 rule 1, Matt OK 2026-11-01). Config may LOWER
 * the cap (KM_KEY_TTL_CAP_S / ttlCapS) but never raise it. Raising it is a code change + review. */
export const HARD_MAX_S = 604800;
/** @deprecated alias kept for readers of the first M3 pass. */
export const KEY_STATEMENT_TTL_CAP_S = HARD_MAX_S;
/** Effective cap: min(HARD_MAX_S, config). Missing, non-integer, zero or negative config -> HARD_MAX_S. */
export function effectiveTtlCap(config?: number | string | null): number {
  const n = typeof config === "string" ? (/^\d+$/.test(config.trim()) ? Number(config.trim()) : NaN) : config ?? NaN;
  return Number.isSafeInteger(n) && (n as number) > 0 ? Math.min(HARD_MAX_S, n as number) : HARD_MAX_S;
}
/** Effective expiry of a statement: min(expires_at, created_at + effective cap). Over-long expiries are clamped. */
export const effectiveExpiry = (p: { created_at: number; expires_at: number }, config?: number | string | null) => Math.min(p.expires_at, p.created_at + effectiveTtlCap(config));
/** Minimum distinct channels for the first pin (v9.2: "at least two"). */
export const MIN_PIN_CHANNELS = 2;

const HEX64 = /^[0-9a-f]{64}$/;
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const dg = (domain: string, p: unknown) => bytesToHex(sha256(utf8ToBytes(`${domain}\n${canonicalJson(p)}`)));
/** Digest of a 32-byte x-only pubkey (hex), as committed in next_key_digest. */
export const keyDigest = (pubHex: string) => bytesToHex(sha256(hexToBytes(pubHex)));
const pubOf = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
const sig = (idHex: string, sk: Uint8Array) => bytesToHex(secp.schnorr.sign(hexToBytes(idHex), sk));
function ver(sigHex: unknown, idHex: string, pub: string): boolean {
  try { return typeof sigHex === "string" && /^[0-9a-f]{128}$/.test(sigHex) && secp.schnorr.verify(hexToBytes(sigHex), hexToBytes(idHex), hexToBytes(pub)); } catch { return false; }
}

export interface KeyStatementPayload {
  type: "klickymart-key-statement"; v: 1; seq: number; key: string; prev: string | null;
  next_key_digest: string; revocation_key: string; created_at: number; expires_at: number;
}
export interface KeyStatement { payload: KeyStatementPayload; hash: string; sig_prev: string | null; sig_self: string }
export interface RevokePayload { type: "klickymart-key-revoke"; v: 1; target: string; revocation_key: string; created_at: number }
export interface Revoke { payload: RevokePayload; hash: string; sig: string }
export interface RevkeyRotatePayload { type: "klickymart-revkey-rotate"; v: 1; stmt: string; old_revocation_key: string; new_revocation_key: string; created_at: number }
export interface RevkeyRotate { payload: RevkeyRotatePayload; hash: string; sig_signing: string; sig_old_rev: string }

// ---------------- Building records (operator side; tests use throwaway keys) ----------------

export function makeInception(sk: Uint8Array, nextPub: string, revPub: string, createdAt: number, expiresAt: number): KeyStatement {
  const payload: KeyStatementPayload = { type: "klickymart-key-statement", v: 1, seq: 0, key: pubOf(sk), prev: null, next_key_digest: keyDigest(nextPub), revocation_key: revPub, created_at: createdAt, expires_at: expiresAt };
  const hash = dg(KEYSTMT_DOMAIN, payload);
  return { payload, hash, sig_prev: null, sig_self: sig(hash, sk) };
}
export function makeHandover(prev: KeyStatement, prevSk: Uint8Array, newSk: Uint8Array, nextPub: string, revPub: string, createdAt: number, expiresAt: number): KeyStatement {
  const payload: KeyStatementPayload = { type: "klickymart-key-statement", v: 1, seq: prev.payload.seq + 1, key: pubOf(newSk), prev: prev.hash, next_key_digest: keyDigest(nextPub), revocation_key: revPub, created_at: createdAt, expires_at: expiresAt };
  const hash = dg(KEYSTMT_DOMAIN, payload);
  return { payload, hash, sig_prev: sig(hash, prevSk), sig_self: sig(hash, newSk) };
}
export function makeRevoke(revSk: Uint8Array, target: string, createdAt: number): Revoke {
  const payload: RevokePayload = { type: "klickymart-key-revoke", v: 1, target, revocation_key: pubOf(revSk), created_at: createdAt };
  const hash = dg(REVOKE_DOMAIN, payload);
  return { payload, hash, sig: sig(hash, revSk) };
}
export function makeRevkeyRotate(stmt: KeyStatement, signingSk: Uint8Array, oldRevSk: Uint8Array, newRevPub: string, createdAt: number): RevkeyRotate {
  const payload: RevkeyRotatePayload = { type: "klickymart-revkey-rotate", v: 1, stmt: stmt.hash, old_revocation_key: pubOf(oldRevSk), new_revocation_key: newRevPub, created_at: createdAt };
  const hash = dg(REVKEY_ROTATE_DOMAIN, payload);
  return { payload, hash, sig_signing: sig(hash, signingSk), sig_old_rev: sig(hash, oldRevSk) };
}
export const statementHash = (p: KeyStatementPayload) => dg(KEYSTMT_DOMAIN, p);

// ---------------- Structural checks (no lineage context) ----------------

function shapeStatement(s: KeyStatement): string | null {
  const p = s?.payload;
  if (!p || p.type !== "klickymart-key-statement" || p.v !== 1) return "malformed";
  if (!isInt(p.seq) || !isInt(p.created_at) || !isInt(p.expires_at)) return "malformed";
  if (!HEX64.test(p.key) || !HEX64.test(p.next_key_digest) || !HEX64.test(p.revocation_key)) return "malformed";
  if (p.seq === 0 ? p.prev !== null : !(typeof p.prev === "string" && HEX64.test(p.prev))) return "malformed";
  if (dg(KEYSTMT_DOMAIN, p) !== s.hash) return "hash does not match payload";
  if (p.expires_at <= p.created_at) return "expires before it starts";
  if (p.revocation_key === p.key) return "revocation key equals signing key";
  if (p.next_key_digest === keyDigest(p.key)) return "next key is the same key (self-extension)";
  if (!ver(s.sig_self, s.hash, p.key)) return "no proof of possession by the statement key";
  return null;
}

// ---------------- Harness state ----------------

export interface KeyState {
  v: 1;
  root: string;                         // pinned inception statement hash
  stmts: KeyStatement[];                // every structurally valid statement seen (append-only)
  revokes: Revoke[];                    // every revoke seen whose signature checks against SOME revocation key (validated in evaluate)
  revkeyRotations: RevkeyRotate[];
  compromised: string | null;           // sticky; never cleared except by an explicit re-pin
}
export type AddOutcome = "accepted" | "duplicate" | "rejected";

export function newKeyState(root: string): KeyState { return { v: 1, root, stmts: [], revokes: [], revkeyRotations: [], compromised: null }; }

/** First pin (TOFU): every channel must report the same root hash and at least MIN_PIN_CHANNELS distinct channels must
 * answer. Any disagreement, a missing answer or too few channels -> no pin (fail closed). */
export function pinFromChannels(answers: { channel: string; root: string | null }[], min = MIN_PIN_CHANNELS): { ok: true; root: string } | { ok: false; reason: string } {
  const by = new Map<string, string | null>();
  for (const a of answers) { if (by.has(a.channel) && by.get(a.channel) !== a.root) return { ok: false, reason: `channel ${a.channel} answered twice, differently` }; by.set(a.channel, a.root); }
  const vals = [...by.values()];
  if (vals.some((v) => v === null || !HEX64.test(v))) return { ok: false, reason: "a channel is unreachable or malformed" };
  if (new Set(vals).size > 1) return { ok: false, reason: "channels disagree on the root" };
  if (by.size < min) return { ok: false, reason: `need ${min} channels, got ${by.size}` };
  return { ok: true, root: vals[0]! };
}

/** Explicit re-pin: a new root, but revokes and rotations already seen are kept (revokes never go away). */
export function repin(old: KeyState, root: string): KeyState { return { ...newKeyState(root), revokes: [...old.revokes], revkeyRotations: [...old.revkeyRotations] }; }

export function addStatement(st: KeyState, s: KeyStatement): { outcome: AddOutcome; reason?: string } {
  const e = shapeStatement(s); if (e) return { outcome: "rejected", reason: e };
  if (st.stmts.some((x) => x.hash === s.hash)) return { outcome: "duplicate" };
  st.stmts.push(s); evaluate(st, Number.MAX_SAFE_INTEGER); // compromise detection is time-independent
  return { outcome: "accepted" };
}
export function addRevoke(st: KeyState, r: Revoke): { outcome: AddOutcome; reason?: string } {
  const p = r?.payload;
  if (!p || p.type !== "klickymart-key-revoke" || p.v !== 1 || !HEX64.test(p.target) || !HEX64.test(p.revocation_key) || !isInt(p.created_at)) return { outcome: "rejected", reason: "malformed" };
  if (dg(REVOKE_DOMAIN, p) !== r.hash || !ver(r.sig, r.hash, p.revocation_key)) return { outcome: "rejected", reason: "bad signature" };
  if (st.revokes.some((x) => x.hash === r.hash)) return { outcome: "duplicate" };
  st.revokes.push(r); return { outcome: "accepted" };
}
export function addRevkeyRotate(st: KeyState, r: RevkeyRotate): { outcome: AddOutcome; reason?: string } {
  const p = r?.payload;
  if (!p || p.type !== "klickymart-revkey-rotate" || p.v !== 1 || !HEX64.test(p.stmt) || !HEX64.test(p.old_revocation_key) || !HEX64.test(p.new_revocation_key) || !isInt(p.created_at)) return { outcome: "rejected", reason: "malformed" };
  if (dg(REVKEY_ROTATE_DOMAIN, p) !== r.hash) return { outcome: "rejected", reason: "hash does not match payload" };
  if (!ver(r.sig_old_rev, r.hash, p.old_revocation_key)) return { outcome: "rejected", reason: "needs the old revocation key's signature" };
  // The signing-key half is checked against the named statement in evaluate (the statement may arrive later).
  if (st.revkeyRotations.some((x) => x.hash === r.hash && x.sig_signing === r.sig_signing)) return { outcome: "duplicate" };
  st.revkeyRotations.push(r); return { outcome: "accepted" };
}

export interface LineageView {
  chain: KeyStatement[];              // valid lineage from the root, in order
  revokedFrom: number | null;         // index into chain; that statement and all descendants are revoked
  compromised: string | null;
  effectiveRevKey: (i: number) => string | null; // revocation key in force for chain[i]
}

/** Rebuild the lineage from the pinned root. Pure apart from latching st.compromised (sticky). */
export function evaluate(st: KeyState, _nowS: number): LineageView {
  const chain: KeyStatement[] = [];
  let compromised = st.compromised;
  // Two different statements at one lineage position (same seq) that both chain from our lineage, or any second
  // inception for the root key = compromise. Statements are never ordered by created_at.
  const root = st.stmts.find((s) => s.hash === st.root && s.payload.seq === 0);
  const revKeys: string[] = [];
  if (root) {
    chain.push(root); revKeys.push(root.payload.revocation_key);
    for (;;) {
      const cur = chain[chain.length - 1]!;
      const i = chain.length - 1;
      const kids = st.stmts.filter((s) => s.payload.prev === cur.hash && s.payload.seq === cur.payload.seq + 1 && validHandover(cur, s, revKeys[i]!, st));
      if (!kids.length) break;
      if (kids.length > 1) { compromised = compromised ?? `fork at seq ${cur.payload.seq + 1}: ${kids.length} handovers from ${cur.hash.slice(0, 12)}`; break; }
      // Same position, different statement signed by the same key (an "edited" statement) also counts, even if it does not chain.
      chain.push(kids[0]!); revKeys.push(nextRevKey(cur, revKeys[i]!, st) ?? revKeys[i]!);
    }
    for (let i = 0; i < chain.length; i++) {
      if (revRotations(chain[i]!, revKeys[i]!, st).fork) { compromised = compromised ?? `revocation-key rotation fork at seq ${chain[i]!.payload.seq}`; break; }
    }
    for (const c of chain) {
      const twins = st.stmts.filter((s) => s.hash !== c.hash && s.payload.seq === c.payload.seq && s.payload.key === c.payload.key);
      if (twins.length) { compromised = compromised ?? `two statements at seq ${c.payload.seq} for one key (edited or re-issued)`; break; }
    }
  }
  if (compromised && !st.compromised) st.compromised = compromised;
  const effectiveRevKey = (i: number) => (i >= 0 && i < revKeys.length ? revKeys[i]! : null);
  // Current revocation key: the newest statement's, or the key it was rotated to (the rotation takes effect when accepted).
  const lastI = chain.length - 1;
  const currentRev = lastI >= 0 ? (nextRevKey(chain[lastI]!, revKeys[lastI]!, st) ?? revKeys[lastI]!) : null;
  let revokedFrom: number | null = null;
  for (const r of st.revokes) {
    const i = chain.findIndex((c) => c.hash === r.payload.target);
    if (i < 0) continue; // kept; applies if the target joins the chain later
    // The revocation key never certifies anything.
    // Only the CURRENT revocation key (the one in force for the newest statement) can revoke. A replaced revocation key
    // can't (Satoshi final M3 rule 3): keys are rolled because they expired or were compromised.
    const ok = r.payload.revocation_key === currentRev;
    if (ok && (revokedFrom === null || i < revokedFrom)) revokedFrom = i;
  }
  return { chain, revokedFrom, compromised, effectiveRevKey };
}

/** Revocation key in force after `cur`: a rotation for cur signed by cur's key AND the old revocation key. Two valid
 * rotations naming different new keys for one statement are a FORK (Satoshi final M3 rule 6): the caller marks the
 * lineage terminal. We never pick "the most recent": created_at is self-asserted, so whoever holds both keys could
 * always out-date the other side. */
function revRotations(cur: KeyStatement, oldRev: string, st: KeyState): { key: string | null; fork: boolean } {
  const rs = st.revkeyRotations.filter((r) => r.payload.stmt === cur.hash && r.payload.old_revocation_key === oldRev && ver(r.sig_signing, r.hash, cur.payload.key) && ver(r.sig_old_rev, r.hash, oldRev));
  const keys = new Set(rs.map((r) => r.payload.new_revocation_key));
  return keys.size === 1 ? { key: [...keys][0]!, fork: false } : { key: null, fork: keys.size > 1 };
}
const nextRevKey = (cur: KeyStatement, oldRev: string, st: KeyState) => revRotations(cur, oldRev, st).key;

function validHandover(prev: KeyStatement, s: KeyStatement, prevRev: string, st: KeyState): boolean {
  if (shapeStatement(s)) return false;
  if (keyDigest(s.payload.key) !== prev.payload.next_key_digest) return false; // only to the pre-announced successor
  if (s.payload.key === prev.payload.key) return false;                       // no self-extension
  if (!ver(s.sig_prev, s.hash, prev.payload.key)) return false;              // authorised by the current key, not the revocation key
  const rev = nextRevKey(prev, prevRev, st) ?? prevRev;
  if (s.payload.revocation_key !== rev) return false;                         // revocation key changes only by a two-key rotation
  return true;
}

/** Why a single handover candidate is invalid (for diagnostics/tests). */
export function handoverProblem(prev: KeyStatement, s: KeyStatement, st: KeyState): string | null {
  const e = shapeStatement(s); if (e) return e;
  if (s.payload.prev !== prev.hash || s.payload.seq !== prev.payload.seq + 1) return "does not follow the previous statement";
  if (keyDigest(s.payload.key) !== prev.payload.next_key_digest) return "handover to a key that was not pre-announced";
  if (!ver(s.sig_prev, s.hash, prev.payload.key)) return "not signed by the previous key";
  const v = evaluate(st, 0); const i = v.chain.findIndex((c) => c.hash === prev.hash);
  const rev = i >= 0 ? (nextRevKey(prev, v.effectiveRevKey(i)!, st) ?? v.effectiveRevKey(i)) : null;
  if (rev && s.payload.revocation_key !== rev) return "revocation key changed without a two-key rotation";
  return null;
}

export type StatementStatus = "current" | "superseded" | "revoked" | "expired" | "not_yet_valid" | "compromised" | "unknown";
/** No overlap option: the old key dies the moment its handover is accepted (Satoshi final M3 rule 2). */
export interface KeyOpts { skewS?: number; ttlCapS?: number }

/** Status of the statement named by a result, at the harness's own clock. Only "current" verifies. */
export function statementStatus(st: KeyState, hash: string | null | undefined, nowS: number, o: KeyOpts = {}): { status: StatementStatus; stmt?: KeyStatement; until?: number } {
  const S = o.skewS ?? 60;
  const v = evaluate(st, nowS);
  if (v.compromised) return { status: "compromised" };
  if (!hash) return { status: "unknown" };
  const i = v.chain.findIndex((c) => c.hash === hash);
  if (i < 0) return { status: "unknown" };
  const s = v.chain[i]!;
  if (v.revokedFrom !== null && i >= v.revokedFrom) return { status: "revoked", stmt: s };
  if (s.payload.created_at > nowS + S) return { status: "not_yet_valid", stmt: s };
  const until = effectiveExpiry(s.payload, o.ttlCapS); // over-long expiry is clamped, never trusted
  if (nowS > until) return { status: "expired", stmt: s };
  if (v.chain[i + 1]) return { status: "superseded", stmt: s }; // overlap 0
  return { status: "current", stmt: s, until };
}

/** The statement a producer should sign with right now (last valid, unrevoked, unexpired), or null = fail closed. */
export function currentStatement(st: KeyState, nowS: number, o: KeyOpts = {}): KeyStatement | null {
  const v = evaluate(st, nowS);
  const last = v.chain[v.chain.length - 1];
  if (!last) return null;
  const s = statementStatus(st, last.hash, nowS, o);
  return s.status === "current" ? last : null;
}

// ---------------- Persistence (survives reinstall when the harness restores it) ----------------

export const exportKeyState = (st: KeyState) => JSON.stringify(st);
/** Merge restored state into live state: union of records; compromise latches; revokes are never dropped. Restoring an
 * older backup cannot un-revoke anything already seen by either side. */
export function importKeyState(json: string, into?: KeyState): KeyState {
  const x = JSON.parse(json) as KeyState;
  if (x?.v !== 1 || typeof x.root !== "string") throw new Error("bad key state");
  const st = into ?? newKeyState(x.root);
  if (into && into.root !== x.root) throw new Error("root mismatch: re-pin explicitly");
  for (const s of x.stmts ?? []) addStatement(st, s);
  for (const r of x.revokes ?? []) addRevoke(st, r);
  for (const r of x.revkeyRotations ?? []) addRevkeyRotate(st, r);
  if (x.compromised && !st.compromised) st.compromised = x.compromised;
  evaluate(st, 0);
  return st;
}

export function keyLifecycleEnabled(env: { KM_KEY_LIFECYCLE?: string }): boolean {
  const v = (env.KM_KEY_LIFECYCLE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on"; // default OFF, like M2
}

// ---------------- Harness: results under the key lifecycle ----------------

/** verifyResult plus the M3 checks: the result and its head both name the same key-statement hash, that statement is
 * current in the pinned lineage, both are signed by its key, and acceptance ends no later than the
 * statement's clamped expiry. Compromised, revoked, expired, superseded or unknown statements fail closed. */
export function verifyResultWithKeys(res: Signed<ResultPayload>, head: Signed<HeadPayload>, ks: KeyState, o: Omit<HarnessOpts, "pinned" | "requireKeyStatement"> & KeyOpts): HarnessVerdict & { keyStatus?: StatementStatus } {
  const ksh = res?.payload?.key_statement_hash;
  if (!ksh) return { ok: false, reason: "result: no key statement" };
  if (head?.payload?.key_statement_hash !== ksh) return { ok: false, reason: "head: does not name the result's key statement" };
  const s = statementStatus(ks, ksh, o.nowS, o);
  if (s.status !== "current") return { ok: false, reason: `key statement ${s.status}`, keyStatus: s.status };
  const v = verifyResult(res, head, { ...o, pinned: s.stmt!.payload.key, requireKeyStatement: true });
  if (!v.ok) return v;
  return { ...v, acceptUntil: Math.min(v.acceptUntil, s.until!), keyStatus: s.status };
}

/** Liveness at payment time: cached acceptance only while its key statement is still current in the (persisted) lineage;
 * a revoke seen after caching kills it. Otherwise fail closed (relay-only reading stays opt-in). */
export function paymentGateWithKeys(cached: { acceptUntil: number; key_statement_hash: string } | null, ks: KeyState, nowS: number, relayOnlyOptIn = false, o: KeyOpts = {}): "use_cache" | "relay_only" | "fail_closed" {
  if (cached && nowS <= cached.acceptUntil) {
    const s = statementStatus(ks, cached.key_statement_hash, nowS, o).status;
    if (s === "current") return "use_cache";
  }
  return relayOnlyOptIn ? "relay_only" : "fail_closed";
}

// ---------------- Worker side ----------------

export type KeyRecordKind = "statement" | "revoke" | "revkey_rotate";

/** Insert one record (append-only; a known hash is a no-op). The record is validated first; invalid records are not stored. */
export async function storeKeyRecord(db: D1Database, kind: KeyRecordKind, rec: KeyStatement | Revoke | RevkeyRotate, nowS: number): Promise<AddOutcome> {
  const probe = newKeyState("0".repeat(64));
  const out = kind === "statement" ? addStatement(probe, rec as KeyStatement) : kind === "revoke" ? addRevoke(probe, rec as Revoke) : addRevkeyRotate(probe, rec as RevkeyRotate);
  if (out.outcome === "rejected") return "rejected";
  const body = canonicalJson(rec);
  const id = bytesToHex(sha256(utf8ToBytes(body))); // whole signed record: two rotations with one payload but different signatures both stay
  const r = await db.prepare("INSERT OR IGNORE INTO km_key_records (id, rec_hash, kind, body_json, seen_at) VALUES (?,?,?,?,?)").bind(id, rec.hash, kind, body, nowS).run();
  return (r.meta?.changes ?? 0) > 0 ? "accepted" : "duplicate";
}

/** Load the lineage for a configured root. null on any storage error (callers fail closed). */
export async function loadKeyState(db: D1Database, root: string): Promise<KeyState | null> {
  try {
    const { results } = await db.prepare("SELECT kind, body_json FROM km_key_records ORDER BY id").all<{ kind: KeyRecordKind; body_json: string }>();
    const st = newKeyState(root);
    for (const r of results ?? []) {
      const b = JSON.parse(r.body_json);
      if (r.kind === "statement") addStatement(st, b); else if (r.kind === "revoke") addRevoke(st, b); else if (r.kind === "revkey_rotate") addRevkeyRotate(st, b);
    }
    evaluate(st, 0);
    return st;
  } catch { return null; }
}
