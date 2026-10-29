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
  if (ev.kind !== NOSTR_KIND_CRAWL_RECORD) {
    return { ok: false, reason: `wrong kind ${ev.kind}` };
  }
  if (!ev.pubkey || !/^[0-9a-f]{64}$/i.test(ev.pubkey)) {
    return { ok: false, reason: "invalid pubkey" };
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
