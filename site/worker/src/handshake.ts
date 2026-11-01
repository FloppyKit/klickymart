/**
 * Kinds 420 / 421 / 422 handshake: typed schema + validator (NIP-DRAFT.md "Kinds 420 / 421 / 422", docs/nip-draft/).
 *
 * Validation only MARKS events. It returns errors (malformed: clients SHOULD ignore), warnings, and thread marks.
 * It has no score, weight or rank output, and nothing here is read by ranking code. Payment fields (preimage, zap, cashu)
 * are recorded as *claimed*: a self-minted preimage or a zap receipt from the payee's own LNURL service proves nothing on
 * its own, so this module never marks a payment verified (that needs store-bound keys; see relay-ingest.ts proof tiers).
 * KlickyMart never holds funds or keys; this module only reads signed public events.
 */
import { NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE } from "./nostr-kinds";
import { verifyNostrEvent } from "./nostr-verify";
import type { NostrEventLine as RawLine } from "./nostr-record-source";

/** A fully-populated signed event (all NIP-01 fields present). */
export type NostrEventLine = Required<RawLine>;

export type HandshakeKind = typeof NOSTR_KIND_NEED | typeof NOSTR_KIND_FULFILLMENT | typeof NOSTR_KIND_ACCEPTANCE;
export const PROOF_TYPES = ["url", "sha256", "tracking", "event", "order"] as const;
export type ProofType = (typeof PROOF_TYPES)[number];
/** 21e6 BTC in msat: anything larger is not a bitcoin amount. */
export const MAX_MSAT = 21_000_000n * 100_000_000n * 1000n;

export interface Need { kind: 420; id: string; pubkey: string; offerMsat: bigint | null; offerUnit: string | null; payment: string[][]; directedTo: string[]; expiration: number | null; topics: string[] }
export interface Fulfillment { kind: 421; id: string; pubkey: string; needId: string; requester: string; owedMsat: bigint | null; bolt11: string | null; proofs: { type: ProofType; value: string[] }[] }
export interface Acceptance { kind: 422; id: string; pubkey: string; needId: string | null; fulfillmentId: string | null; fulfiller: string | null; amountMsat: bigint | null; tipMsat: bigint | null; status: "accepted" | "rejected"; claimedPayment: { preimage: string | null; zap: string | null; cashu: boolean }; review: boolean }
export type Handshake = Need | Fulfillment | Acceptance;

export interface EventResult { ok: boolean; errors: string[]; warnings: string[]; parsed: Handshake | null }

const HEX64 = /^[0-9a-f]{64}$/;
const tagsOf = (ev: NostrEventLine, name: string) => ev.tags.filter((t) => Array.isArray(t) && t[0] === name);
const one = (ev: NostrEventLine, name: string) => tagsOf(ev, name)[0];

/** Parse a decimal msat string strictly (no sign, no leading zeros, no exponent, <= MAX_MSAT). */
export function parseMsat(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(v)) return null;
  const n = BigInt(v);
  return n <= MAX_MSAT ? n : null;
}

function eByMarker(ev: NostrEventLine, marker: string): string[][] { return tagsOf(ev, "e").filter((t) => t[3] === marker); }

/** Structural validation of one event. `checkSig` defaults to true (id + BIP-340 signature). */
export function validateHandshakeEvent(ev: NostrEventLine, opts: { checkSig?: boolean } = {}): EventResult {
  const errors: string[] = [], warnings: string[] = [];
  const fail = (): EventResult => ({ ok: false, errors, warnings, parsed: null });
  if (!ev || typeof ev.content !== "string" || typeof ev.id !== "string" || typeof ev.pubkey !== "string" || ![NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE].includes(ev.kind as number)) { errors.push(`not a handshake kind: ${ev?.kind}`); return fail(); }
  if (!Array.isArray(ev.tags) || ev.tags.some((t) => !Array.isArray(t) || t.some((x) => typeof x !== "string"))) { errors.push("tags must be arrays of strings"); return fail(); }
  if (opts.checkSig !== false) { const v = verifyNostrEvent(ev as RawLine, ev.kind); if (!v.ok) { errors.push(v.reason); return fail(); } }

  if (ev.kind === NOSTR_KIND_NEED) {
    const a = one(ev, "amount"); let offerMsat: bigint | null = null, offerUnit: string | null = null;
    if (tagsOf(ev, "amount").length > 1) errors.push("420: at most one amount tag");
    if (a) { offerMsat = parseMsat(a[1]); offerUnit = a[2] ?? "msat"; if (offerMsat === null) errors.push("420: amount must be a decimal msat string"); if (offerUnit !== "msat") warnings.push(`420: unit ${offerUnit} is an indication only; settlement is in bitcoin`); }
    const directedTo = tagsOf(ev, "p").map((t) => t[1]);
    if (directedTo.some((p) => !HEX64.test(p ?? ""))) errors.push("420: p tags must be 64-hex pubkeys");
    const ex = one(ev, "expiration"); const expiration = ex ? Number(ex[1]) : null;
    if (ex && !(Number.isInteger(expiration) && /^[0-9]+$/.test(ex[1]))) errors.push("420: expiration must be a unix timestamp");
    if (eByMarker(ev, "need").length || eByMarker(ev, "fulfillment").length) errors.push("420: must not reference a need or fulfillment");
    if (errors.length) return fail();
    return { ok: true, errors, warnings, parsed: { kind: 420, id: ev.id, pubkey: ev.pubkey, offerMsat, offerUnit, payment: tagsOf(ev, "payment").map((t) => t.slice(1)), directedTo, expiration, topics: tagsOf(ev, "t").map((t) => t[1]) } };
  }

  if (ev.kind === NOSTR_KIND_FULFILLMENT) {
    const needs = eByMarker(ev, "need");
    if (needs.length !== 1 || !HEX64.test(needs[0][1] ?? "")) errors.push("421: exactly one e tag with marker 'need' required");
    const ps = tagsOf(ev, "p");
    if (ps.length !== 1 || !HEX64.test(ps[0][1] ?? "")) errors.push("421: exactly one p tag (requester) required");
    if (eByMarker(ev, "fulfillment").length) errors.push("421: must not reference a fulfillment");
    const a = one(ev, "amount"); let owedMsat: bigint | null = null;
    if (tagsOf(ev, "amount").length > 1) errors.push("421: at most one amount tag");
    if (a) { owedMsat = parseMsat(a[1]); if (owedMsat === null) errors.push("421: amount must be a decimal msat string"); }
    const proofs: Fulfillment["proofs"] = [];
    for (const t of tagsOf(ev, "proof")) {
      if (!(PROOF_TYPES as readonly string[]).includes(t[1]) || !t[2]) { errors.push(`421: bad proof tag (${t[1]})`); continue; }
      if (t[1] === "sha256" && !HEX64.test(t[2])) errors.push("421: proof sha256 must be 64 hex");
      if (t[1] === "event" && !HEX64.test(t[2])) errors.push("421: proof event must be a 64-hex event id");
      proofs.push({ type: t[1] as ProofType, value: t.slice(2) });
    }
    if (!proofs.length && !ev.content.trim()) warnings.push("421: no proof tag and empty content");
    const b = one(ev, "bolt11"); if (b && !/^ln(bc|tb|bcrt)/i.test(b[1] ?? "")) errors.push("421: bolt11 must be a lightning invoice");
    if (errors.length) return fail();
    return { ok: true, errors, warnings, parsed: { kind: 421, id: ev.id, pubkey: ev.pubkey, needId: needs[0][1], requester: ps[0][1], owedMsat, bolt11: b?.[1] ?? null, proofs } };
  }

  // 422
  const needs = eByMarker(ev, "need"), fuls = eByMarker(ev, "fulfillment");
  const review = needs.length === 0;
  if (needs.length > 1 || fuls.length > 1) errors.push("422: at most one need and one fulfillment reference");
  if (needs.length === 1 && fuls.length !== 1) errors.push("422: a 422 on a need must also reference the fulfillment");
  for (const t of [...needs, ...fuls]) if (!HEX64.test(t[1] ?? "")) errors.push("422: e tag ids must be 64 hex");
  const ps = tagsOf(ev, "p");
  if (!review && (ps.length !== 1 || !HEX64.test(ps[0][1] ?? ""))) errors.push("422: exactly one p tag (fulfiller) required");
  if (review && !tagsOf(ev, "a").some((t) => (t[1] ?? "").startsWith("31420:")) && !one(ev, "r")) errors.push("422 review: needs an a 31420:* or r tag");
  const am = one(ev, "amount"), tp = one(ev, "tip");
  const amountMsat = am ? parseMsat(am[1]) : null, tipMsat = tp ? parseMsat(tp[1]) : null;
  if (am && amountMsat === null) errors.push("422: amount must be a decimal msat string");
  if (tp && tipMsat === null) errors.push("422: tip must be a decimal msat string");
  if (tipMsat !== null && amountMsat === null) errors.push("422: tip is a portion of amount; amount required");
  if (tipMsat !== null && amountMsat !== null && tipMsat > amountMsat) errors.push("422: tip exceeds amount");
  const st = one(ev, "status")?.[1] ?? "accepted";
  if (st !== "accepted" && st !== "rejected") errors.push("422: status must be accepted|rejected");
  const pre = one(ev, "preimage")?.[1] ?? null, zap = one(ev, "zap")?.[1] ?? null;
  if (pre !== null && !HEX64.test(pre)) errors.push("422: preimage must be 64 hex");
  if (zap !== null && !HEX64.test(zap)) errors.push("422: zap must be a 9735 event id");
  if (st === "rejected" && (amountMsat || pre || zap)) warnings.push("422: rejected but carries payment fields");
  if (errors.length) return fail();
  return { ok: true, errors, warnings, parsed: { kind: 422, id: ev.id, pubkey: ev.pubkey, needId: needs[0]?.[1] ?? null, fulfillmentId: fuls[0]?.[1] ?? null, fulfiller: ps[0]?.[1] ?? null, amountMsat, tipMsat, status: st as Acceptance["status"], claimedPayment: { preimage: pre, zap, cashu: !!one(ev, "cashu") }, review } };
}

/** Marks a thread check can attach. Marks are labels for display/audit only; none implies a score. */
export type ThreadMark =
  | "duplicate"               // same id seen before (replay); later copies ignored
  | "invalid"                 // failed structural validation
  | "orphan"                  // references an event not in the set
  | "self_fulfillment"        // 421 author == 420 author (same key; cannot detect same operator across keys)
  | "requester_mismatch"      // 421 p tag != 420 author
  | "not_directed"            // 420 is directed (p tags) and 421 author is not listed
  | "acceptor_not_requester"  // 422 author != 420 author: clients MUST ignore
  | "need_mismatch"           // 422's need != the need its 421 references
  | "fulfiller_mismatch"      // 422 p tag != 421 author
  | "owed_exceeds_offer"      // 421 amount > 420 offer (requester MAY decline)
  | "owed_without_offer"      // 421 amount with no offer in the 420
  | "paid_below_owed"         // 422 accepted, amount - tip < 421 amount owed
  | "payment_claimed_unverified" // preimage/zap/cashu present; not verified here
  | "accepted_unpaid"         // 422 accepted with no payment field
  | "multiple_acceptances";   // more than one valid 422 for the same 421

export interface ThreadReport { byId: Map<string, { result: EventResult; marks: ThreadMark[] }>; duplicates: string[]; loops: { need: string; fulfillment: string; acceptance: string }[] }

/** Check references across a set of handshake events. Pure: no I/O, no ranking side effects. */
export function checkThreads(events: NostrEventLine[], opts: { checkSig?: boolean } = {}): ThreadReport {
  const byId: ThreadReport["byId"] = new Map(); const duplicates: string[] = [];
  for (const ev of events) {
    if (byId.has(ev.id)) { duplicates.push(ev.id); byId.get(ev.id)!.marks.includes("duplicate") || byId.get(ev.id)!.marks.push("duplicate"); continue; }
    const result = validateHandshakeEvent(ev, opts);
    byId.set(ev.id, { result, marks: result.ok ? [] : ["invalid"] });
  }
  const get = <K extends Handshake["kind"]>(id: string | null, k: K) => { const p = id ? byId.get(id)?.result.parsed : null; return p && p.kind === k ? (p as Extract<Handshake, { kind: K }>) : null; };
  const loops: ThreadReport["loops"] = []; const acceptCount = new Map<string, number>();
  for (const [, entry] of byId) {
    const p = entry.result.parsed; if (!p) continue; const m = entry.marks;
    if (p.kind === 421) {
      const need = get(p.needId, 420);
      if (!need) { m.push("orphan"); continue; }
      if (need.pubkey === p.pubkey) m.push("self_fulfillment");
      if (p.requester !== need.pubkey) m.push("requester_mismatch");
      if (need.directedTo.length && !need.directedTo.includes(p.pubkey)) m.push("not_directed");
      if (p.owedMsat !== null) { if (need.offerMsat === null) m.push("owed_without_offer"); else if (need.offerUnit === "msat" && p.owedMsat > need.offerMsat) m.push("owed_exceeds_offer"); }
    }
    if (p.kind === 422 && !p.review) {
      const ful = get(p.fulfillmentId, 421), need = get(p.needId, 420);
      if (!ful || !need) { m.push("orphan"); continue; }
      if (p.pubkey !== need.pubkey) m.push("acceptor_not_requester");
      if (ful.needId !== p.needId) m.push("need_mismatch");
      if (p.fulfiller !== ful.pubkey) m.push("fulfiller_mismatch");
      if (p.status === "accepted") {
        const c = p.claimedPayment;
        if (c.preimage || c.zap || c.cashu) m.push("payment_claimed_unverified"); else m.push("accepted_unpaid");
        if (ful.owedMsat !== null && (p.amountMsat === null || p.amountMsat - (p.tipMsat ?? 0n) < ful.owedMsat)) m.push("paid_below_owed");
      }
      const blocking: ThreadMark[] = ["acceptor_not_requester", "need_mismatch", "fulfiller_mismatch"];
      if (!m.some((x) => blocking.includes(x))) {
        acceptCount.set(ful.id, (acceptCount.get(ful.id) ?? 0) + 1);
        if (p.status === "accepted") loops.push({ need: need.id, fulfillment: ful.id, acceptance: p.id });
      }
    }
  }
  for (const [, entry] of byId) { const p = entry.result.parsed; if (p?.kind === 422 && p.fulfillmentId && (acceptCount.get(p.fulfillmentId) ?? 0) > 1) entry.marks.push("multiple_acceptances"); }
  return { byId, duplicates, loops };
}
