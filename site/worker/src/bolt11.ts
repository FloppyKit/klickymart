/** Minimal BOLT11 reader: amount (msat) and payment hash. No signature check (cheap checks only). */
import { bech32 } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils.js";

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
