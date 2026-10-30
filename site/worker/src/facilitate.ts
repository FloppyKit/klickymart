/** POST /facilitate: KlickyMart signs a kind-421 "facilitated fulfillment" for a store that has NOT claimed its listing,
 * after checking the agent's payment proof. The signed event is RETURNED to the agent to publish; KlickyMart never
 * publishes it. It is never a store confirmation: role=facilitator, on_behalf_of=<domain>, verification=<level>.
 * Once a store claims its listing (claims table), only the store's own 421s count, so we refuse to facilitate. */
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { verifyBolt11 } from "./bolt11";
import { checkZapReceipt, claimedKeys } from "./pay-binding";
import { nostrEventId, verifyNostrEvent } from "./nostr-verify";
import { NOSTR_KIND_FULFILLMENT } from "./nostr-kinds";

/** Public key of the facilitator (secret held only as the FACILITATOR_SK_HEX Worker secret). */
export const FACILITATOR_NPUB = "npub1zw8a7v4eyagkd0eqpqle0c06xxnvyuwaps2hyk3xykqgfsa49h9srq3694";
export const FACILITATOR_PUBKEY = "138fdf32b9275166bf20083f97e1fa31a6c271dd0c15725a26258084c3b52dcb";
/** KM-002 hotfix: facilitation is paused until payment proofs are cryptographically verified (KM-001).
 * The code stays; it only runs when the FACILITATE_ENABLED var is exactly "1". */
export function facilitationEnabled(env: { FACILITATE_ENABLED?: string }): boolean { return env.FACILITATE_ENABLED === "1"; }
export const FACILITATION_PAUSED_BODY = { ok: false, error: { code: "facilitation_paused", message: "Facilitation is paused. KlickyMart is not signing facilitated 421s while payment-proof verification is being fixed. Publish your 422 without a facilitated 421.", retryable: false } };
export const FACILITATE_LIMITS = { perAgentPerDay: 5, perIpPerDay: 20, globalPerDay: 500, perAgentDomainPerDay: 1 };
export type Verification = "verified-preimage" | "verified-zap" | "unverified-claim";
export const FACILITATE_NOTE = "Signed by KlickyMart as FACILITATOR, not by the store. It records that an agent showed KlickyMart this payment proof; it is not a store confirmation. KlickyMart does not publish it: publish it yourself, then reference it from your 422.";

type Ev = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
type Res = { status: number; body: Record<string, unknown> };
const bad = (code: string, message: string, status = 400): Res => ({ status, body: { ok: false, error: { code, message } } });
const HEX64 = /^[0-9a-f]{64}$/;

export interface FacilitateInput { domain?: unknown; agent_pubkey?: unknown; need_id?: unknown; proof?: unknown; amount_msat?: unknown }

/** Check the proof; never throws. KM-001/KM-002: facilitation is only for stores that have NOT claimed their listing, so
 * there is never a store-bound node key or LNURL nostrPubkey to check against. Every proof is therefore at most an
 * "unverified-claim": KlickyMart never signs "verified" for a proof it cannot bind to the store. The preimage invoice must
 * still carry a valid node signature and match the preimage; a zap must still pass the NIP-57 structure checks. */
export function checkFacilitationProof(proof: unknown): { ok: true; verification: Verification; tags: string[][]; amount_msat: number | null } | { ok: false; code: string; message: string } {
  if (!proof || typeof proof !== "object") return { ok: false, code: "bad_proof", message: "proof must be {type:'preimage',preimage,bolt11} | {type:'zap',receipt} | {type:'hash',sha256}" };
  const p = proof as Record<string, unknown>;
  if (p.type === "preimage") {
    const pre = String(p.preimage ?? "").toLowerCase(); const inv = String(p.bolt11 ?? "");
    if (!HEX64.test(pre)) return { ok: false, code: "bad_proof", message: "preimage must be 64 hex chars" };
    const dec = verifyBolt11(inv);
    if (!dec) return { ok: false, code: "bad_proof", message: "bolt11 did not decode or its node signature is invalid" };
    if (bytesToHex(sha256(hexToBytes(pre))) !== dec.payment_hash) return { ok: false, code: "proof_mismatch", message: "sha256(preimage) does not match the invoice payment_hash" };
    return { ok: true, verification: "unverified-claim", tags: [["proof", "preimage", pre], ["bolt11", inv], ["payment_hash", dec.payment_hash], ["payee", dec.payee]], amount_msat: dec.amount_msat };
  }
  if (p.type === "zap") {
    const r = p.receipt as Ev;
    if (!r || typeof r !== "object" || !verifyNostrEvent(r as never, 9735).ok) return { ok: false, code: "bad_proof", message: "receipt must be a validly signed kind-9735 event" };
    const zc = checkZapReceipt(r, r.pubkey); // structure only: the signer cannot be bound to an unclaimed store
    if (!zc.ok) return { ok: false, code: "bad_proof", message: `zap receipt failed NIP-57 checks (${zc.reason})` };
    return { ok: true, verification: "unverified-claim", tags: [["proof", "zap", r.id], ["bolt11", tagv(r.tags, "bolt11")!]], amount_msat: zc.inv.amount_msat };
  }
  if (p.type === "hash") {
    const h = String(p.sha256 ?? "").toLowerCase();
    if (!HEX64.test(h)) return { ok: false, code: "bad_proof", message: "sha256 must be 64 hex chars (hash of your redacted receipt; never send the receipt itself)" };
    return { ok: true, verification: "unverified-claim", tags: [["proof", "order_hash", h]], amount_msat: null };
  }
  return { ok: false, code: "bad_proof", message: "unknown proof.type (preimage | zap | hash)" };
}
const tagv = (tags: string[][], k: string) => tags.find((t) => t[0] === k)?.[1];

export async function signEvent(skHex: string, tmpl: Omit<Ev, "id" | "pubkey" | "sig">): Promise<Ev> {
  const sk = hexToBytes(skHex);
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk));
  const id = nostrEventId({ ...tmpl, pubkey });
  const sig = bytesToHex(await secp.schnorr.signAsync(hexToBytes(id), sk));
  return { ...tmpl, pubkey, id, sig };
}

async function bump(kv: KVNamespace, key: string, limit: number): Promise<boolean> {
  const n = Number((await kv.get(key)) ?? 0);
  if (n >= limit) return false;
  await kv.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
  return true;
}

export async function facilitate(env: { DB?: D1Database; KV: KVNamespace; FACILITATOR_SK_HEX?: string }, input: FacilitateInput, known: (d: string) => boolean, ip: string, now = Date.now()): Promise<Res> {
  if (input && typeof input === "object" && Object.keys(input).some((k) => /nsec|secret|private|sk$/i.test(k)))
    return bad("secret_sent", "Never send a secret key. Send only your public key (hex) as agent_pubkey.");
  const d = String(input.domain ?? "").toLowerCase().replace(/^www\./, "");
  if (!known(d)) return bad("unknown_domain", "domain is not in the KlickyMart index");
  const agent = String(input.agent_pubkey ?? "").toLowerCase();
  if (!HEX64.test(agent)) return bad("bad_param", "agent_pubkey must be your 64-hex public key (the key that will sign the 422)");
  const need = input.need_id == null ? null : String(input.need_id).toLowerCase();
  if (need !== null && !HEX64.test(need)) return bad("bad_param", "need_id must be a 64-hex event id");
  if (env.DB) {
    try {
      // KIMI-004: NIP-05 claims AND active DNS store_claims both stop facilitation.
      const c = (await claimedKeys(env.DB, d))[0];
      if (c) return bad("store_claimed", `This store claimed its listing (key ${c}); only the store's own 421s count now. Ask the store to sign.`, 409);
    } catch { /* claims table missing */ }
  }
  const pr = checkFacilitationProof(input.proof);
  if (!pr.ok) return bad(pr.code, pr.message);
  if (!env.FACILITATOR_SK_HEX || !HEX64.test(env.FACILITATOR_SK_HEX)) return bad("not_configured", "facilitator key not configured", 503);
  const day = new Date(now).toISOString().slice(0, 10);
  for (const [k, lim] of [[`fac:g:${day}`, FACILITATE_LIMITS.globalPerDay], [`fac:ip:${bytesToHex(sha256(new TextEncoder().encode(`${day}:${ip}`))).slice(0, 16)}:${day}`, FACILITATE_LIMITS.perIpPerDay], [`fac:pk:${agent}:${day}`, FACILITATE_LIMITS.perAgentPerDay], [`fac:pkd:${agent}:${d}:${day}`, FACILITATE_LIMITS.perAgentDomainPerDay]] as const)
    if (!(await bump(env.KV, k, lim))) return bad("rate_limited", `facilitation limit reached (${JSON.stringify(FACILITATE_LIMITS)})`, 429);
  const amt = pr.amount_msat ?? (Number.isFinite(Number(input.amount_msat)) && Number(input.amount_msat) > 0 ? Math.floor(Number(input.amount_msat)) : null);
  const label = pr.verification === "unverified-claim" ? "UNVERIFIED CLAIM: KlickyMart could not bind this payment to the store." : `Payment proof checked by KlickyMart (${pr.verification}).`;
  const tags: string[][] = [["r", d], ["on_behalf_of", d], ["role", "facilitator"], ["verification", pr.verification], ["p", agent],
    ...(need ? [["e", need, "", "need"]] : []), ...pr.tags, ...(amt ? [["amount", String(amt)]] : []),
    ["L", "klickymart.facilitated"], ["l", pr.verification, "klickymart.facilitated"]];
  const ev = await signEvent(env.FACILITATOR_SK_HEX, { kind: NOSTR_KIND_FULFILLMENT, created_at: Math.floor(now / 1000), tags,
    content: `Facilitated fulfillment for ${d}, signed by KlickyMart as facilitator (not the store). ${label}` });
  return { status: 200, body: { ok: true, verification: pr.verification, label, event: ev, facilitator_npub: FACILITATOR_NPUB, published: false, note: FACILITATE_NOTE,
    next: "Publish this 421 to your relays yourself, then publish your 422 with [\"e\", <this id>, \"\", \"fulfillment\"] (+ your preimage/zap proof tag)." } };
}

export const HISTORY_STATUS = "facilitated-history";
/** After a store claims its listing, facilitated 421s (signed by our facilitator key) are history only: notes and reviews that
 * cite one keep it visible but get proof_status "facilitated-history" (no proof weight, never store-confirmed, not a
 * verified payment). Idempotent; call after a claim and after storing notes/reviews for a claimed domain. */
export async function markFacilitatedHistory(db: D1Database, d: string): Promise<number> {
  try {
    // KIMI-004: any claim (NIP-05 claims table or an active DNS store_claims row) turns facilitated 421s into history.
    if (!(await claimedKeys(db, d)).length) return 0;
    const { results } = await db.prepare("SELECT id FROM nostr_events WHERE kind = ? AND pubkey = ? AND d = ?").bind(NOSTR_KIND_FULFILLMENT, FACILITATOR_PUBKEY, d).all<{ id: string }>();
    let n = 0;
    for (const { id } of results ?? []) {
      const r = await db.batch([
        db.prepare("UPDATE reviews SET proof_status = ? WHERE d = ? AND fulfillment = ? AND IFNULL(proof_status,'') != ?").bind(HISTORY_STATUS, d, id, HISTORY_STATUS),
        db.prepare("UPDATE experiences SET proof_status = ? WHERE d = ? AND instr(raw_json, ?) > 0 AND IFNULL(proof_status,'') != ?").bind(HISTORY_STATUS, d, id, HISTORY_STATUS),
      ]);
      n += r.reduce((a, x) => a + (x.meta?.changes ?? 0), 0);
    }
    return n;
  } catch { return 0; }
}
