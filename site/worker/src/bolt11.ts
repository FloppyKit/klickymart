/** Minimal BOLT11 reader: amount (msat) and payment hash. decodeBolt11 does no signature check (display only);
 * verifyBolt11 (KM-001) also checks the node's recoverable ECDSA signature and returns the payee node key. */
import { bech32 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as secp from "@noble/secp256k1";

const MULT: Record<string, number> = { m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };

export function decodeBolt11(invoice: string): { amount_msat: number | null; payment_hash: string; timestamp: number } | null {
  try {
    const { prefix, words } = bech32.decode(invoice.toLowerCase() as `${string}1${string}`, 10_000);
    const m = prefix.match(/^ln(?:bc|tb|bcrt|tbs)(\d+)?([munp])?$/);
    if (!m) return null;
    let amount_msat: number | null = null;
    if (m[1]) amount_msat = Math.round(Number(m[1]) * (m[2] ? MULT[m[2]]! : 1) * 1e11);
    const data = words.slice(0, words.length - 104); // strip 520-bit signature
    let ts = 0;
    for (let i = 0; i < 7; i++) ts = ts * 32 + data[i]!;
    let i = 7;
    while (i + 3 <= data.length) {
      const type = data[i]!; const len = data[i + 1]! * 32 + data[i + 2]!;
      const field = data.slice(i + 3, i + 3 + len);
      if (type === 1 && len === 52) {
        return { amount_msat, payment_hash: bytesToHex(wordsToBytes(field)).slice(0, 64), timestamp: ts };
      }
      i += 3 + len;
    }
    return null;
  } catch {
    return null;
  }
}

function wordsToBytes(words: number[]): Uint8Array {
  const out: number[] = []; let acc = 0; let bits = 0;
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } acc &= (1 << bits) - 1; }
  return new Uint8Array(out);
}

export interface VerifiedBolt11 { amount_msat: number | null; payment_hash: string; timestamp: number; payee: string; description_hash: string | null; expiry_s: number }

/** KM-001: decode AND verify a BOLT11 invoice. The 65-byte signature (r||s||recid) over sha256(hrp || data) must recover a
 * node key; if the invoice carries an explicit `n` field the recovered key must equal it. Returns null on any failure,
 * so a self-made invoice with a zero or wrong signature never verifies. */
export function verifyBolt11(invoice: string): VerifiedBolt11 | null {
  try {
    const lower = invoice.toLowerCase();
    const { prefix, words } = bech32.decode(lower as `${string}1${string}`, 10_000);
    const m = prefix.match(/^ln(?:bc|tb|bcrt|tbs)(\d+)?([munp])?$/);
    if (!m || words.length < 7 + 104) return null;
    let amount_msat: number | null = null;
    if (m[1]) amount_msat = Math.round(Number(m[1]) * (m[2] ? MULT[m[2]]! : 1) * 1e11);
    const data = words.slice(0, words.length - 104);
    const sigBytes = wordsToBytes(words.slice(words.length - 104));
    if (sigBytes.length !== 65 || sigBytes[64]! > 3) return null;
    const msg = sha256(new Uint8Array([...new TextEncoder().encode(prefix), ...wordsToBytesPadded(data)]));
    const recovered = new Uint8Array([sigBytes[64]!, ...sigBytes.slice(0, 64)]);
    let payee: string;
    try { payee = bytesToHex(secp.recoverPublicKey(recovered, msg, { prehash: false })); } catch { return null; }
    let ts = 0;
    for (let i = 0; i < 7; i++) ts = ts * 32 + data[i]!;
    let payment_hash: string | null = null; let description_hash: string | null = null; let n: string | null = null; let expiry_s = 3600;
    let i = 7;
    while (i + 3 <= data.length) {
      const type = data[i]!; const len = data[i + 1]! * 32 + data[i + 2]!;
      const field = data.slice(i + 3, i + 3 + len);
      if (type === 1 && len === 52) payment_hash = bytesToHex(wordsToBytes(field)).slice(0, 64);
      else if (type === 23 && len === 52) description_hash = bytesToHex(wordsToBytes(field)).slice(0, 64);
      else if (type === 19 && len === 53) n = bytesToHex(wordsToBytes(field)).slice(0, 66);
      else if (type === 6) { let e = 0; for (const w of field) e = e * 32 + w; expiry_s = e; }
      i += 3 + len;
    }
    if (!payment_hash) return null;
    if (n) {
      const sig = secp.Signature.fromBytes(sigBytes.slice(0, 64), "compact");
      if (n !== payee || !secp.verify(sig.toBytes("compact"), msg, hexToBytesLocal(n), { prehash: false })) return null;
    }
    return { amount_msat, payment_hash, timestamp: ts, payee, description_hash, expiry_s };
  } catch {
    return null;
  }
}

function wordsToBytesPadded(words: number[]): Uint8Array {
  const out: number[] = []; let acc = 0; let bits = 0;
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } acc &= (1 << bits) - 1; }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return new Uint8Array(out);
}
function hexToBytesLocal(h: string): Uint8Array { const o = new Uint8Array(h.length / 2); for (let k = 0; k < o.length; k++) o[k] = parseInt(h.slice(k * 2, k * 2 + 2), 16); return o; }

/** Test/tool helper: build a correctly signed BOLT11 for a given node secret key (used by tests; never for real payments). */
export function encodeBolt11ForTest(nodeSk: Uint8Array, hrp: string, paymentHashHex: string, opts: { descriptionHashHex?: string; timestamp?: number } = {}): string {
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000); const w: number[] = [];
  for (let k = 6; k >= 0; k--) w.push(Math.floor(ts / 32 ** k) % 32);
  const field = (type: number, hex: string) => { const fw = bech32.toWords(hexToBytesLocal(hex)); w.push(type, Math.floor(fw.length / 32), fw.length % 32, ...fw); };
  field(1, paymentHashHex);
  if (opts.descriptionHashHex) field(23, opts.descriptionHashHex);
  const msg = sha256(new Uint8Array([...new TextEncoder().encode(hrp), ...wordsToBytesPadded(w)]));
  const rec = secp.sign(msg, nodeSk, { prehash: false, format: "recovered" });
  const sig65 = new Uint8Array([...rec.slice(1), rec[0]!]);
  return bech32.encode(hrp, [...w, ...bech32.toWords(sig65)], 10_000);
}
