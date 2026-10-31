import * as secp from "@noble/secp256k1";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { NostrEventLine } from "./nostr-record-source";
import { NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";

secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
secp.hashes.sha256 = sha256;

export function nostrEventId(ev: Pick<NostrEventLine, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  const payload = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  return bytesToHex(sha256(utf8ToBytes(payload)));
}

export function verifyNostr31420Event(ev: NostrEventLine): { ok: true } | { ok: false; reason: string } {
  return verifyNostrEvent(ev, NOSTR_KIND_CRAWL_RECORD);
}

/** Verify id + BIP-340 signature of any event of the expected kind. */
export function verifyNostrEvent(ev: NostrEventLine, kind: number): { ok: true } | { ok: false; reason: string } {
  if (ev.kind !== kind) {
    return { ok: false, reason: `wrong kind ${ev.kind}` };
  }
  if (typeof ev.created_at !== "number" || !Array.isArray(ev.tags) || typeof ev.content !== "string") {
    return { ok: false, reason: "malformed event" };
  }
  if (!ev.pubkey || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) {
    // Customer audit 2026-10-31: explain the common 33-byte compressed-key mistake (NIP-01 ids hash the 32-byte x-only key,
    // so a 66-char key can't be accepted without changing the event id).
    const compressed = typeof ev.pubkey === "string" && /^0[23][0-9a-f]{64}$/i.test(ev.pubkey);
    return { ok: false, reason: compressed ? "invalid pubkey: got a 33-byte compressed key (66 hex); Nostr needs the 32-byte x-only BIP-340 key: drop the leading 02/03 and re-sign" : "invalid pubkey: must be 64 lowercase hex chars (32-byte x-only BIP-340 public key, not npub or a 33-byte compressed key)" };
  }
  if (!ev.sig || !/^[0-9a-f]{128}$/i.test(ev.sig)) {
    return { ok: false, reason: "invalid sig" };
  }
  if (!ev.id || !/^[0-9a-f]{64}$/i.test(ev.id)) {
    return { ok: false, reason: "invalid id" };
  }
  const computed = nostrEventId(ev);
  if (computed !== ev.id.toLowerCase()) {
    return { ok: false, reason: "id mismatch" };
  }
  try {
    const valid = secp.schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
    if (!valid) return { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "signature verify failed" };
  }
  return { ok: true };
}
