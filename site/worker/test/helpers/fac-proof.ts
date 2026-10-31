import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeBolt11ForTest } from "../../src/bolt11";
/** A structurally valid facilitation proof (node-signed test invoice + matching preimage). Bare hashes are refused now. */
export function facProof() {
  const pre = bytesToHex(secp.utils.randomSecretKey());
  return { type: "preimage", preimage: pre, bolt11: encodeBolt11ForTest(secp.utils.randomSecretKey(), "lnbc10u", bytesToHex(sha256(hexToBytes(pre)))) };
}
