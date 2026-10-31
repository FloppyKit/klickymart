/** Minimal NUT-00/01/02/03 mock mint for tests: real BDHKE signing (C_ = k * B_) with a fresh keyset, accepts any
 * inputs (the client is under test, not the mint) and records swap requests. No real money anywhere. */
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function makeMockMint(base: string) {
  const amounts = Array.from({ length: 16 }, (_, i) => 2 ** i);
  const priv = new Map<number, Uint8Array>(); const pub: Record<string, string> = {};
  for (const a of amounts) { const k = secp.utils.randomSecretKey(); priv.set(a, k); pub[String(a)] = bytesToHex(secp.getPublicKey(k, true)); }
  const all = new Uint8Array(amounts.flatMap((a) => [...secp.Point.fromHex(pub[String(a)]).toBytes(true)]));
  const id = "00" + bytesToHex(sha256(all)).slice(0, 14);
  const swaps: { inputs: unknown[]; outputs: { amount: number; id: string; B_: string }[] }[] = [];
  const sign = (o: { amount: number; id: string; B_: string }) => ({ amount: o.amount, id, C_: bytesToHex(secp.Point.fromHex(o.B_).multiply(secp.etc.bytesToNumberBE(priv.get(o.amount)!)).toBytes(true)) });
  /** Fake input proofs (valid curve points; this mock does not verify inputs). */
  const fakeProofs = (total: number) => { const out: { id: string; amount: number; secret: string; C: string }[] = []; let left = total;
    for (const a of [...amounts].reverse()) while (left >= a) { left -= a; out.push({ id, amount: a, secret: bytesToHex(secp.utils.randomSecretKey()), C: bytesToHex(secp.getPublicKey(secp.utils.randomSecretKey(), true)) }); }
    return out; };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  async function handle(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url); if (!url.startsWith(base)) return json({ detail: "wrong mint" }, 404);
    const p = u.pathname.replace(new URL(base).pathname.replace(/\/$/, ""), "");
    if ((init?.method ?? "GET") === "OPTIONS") return json({});
    if (p === "/v1/info") return json({ name: "mock mint", pubkey: pub["1"], version: "mock/0.1", nuts: { "4": { methods: [], disabled: true }, "5": { methods: [], disabled: true }, "7": { supported: true }, "11": { supported: true } } });
    if (p === "/v1/keysets") return json({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (p === "/v1/keys" || p === `/v1/keys/${id}`) return json({ keysets: [{ id, unit: "sat", active: true, keys: pub }] });
    if (p === "/v1/swap") { const b = JSON.parse(String(init?.body ?? "{}")); swaps.push(b); return json({ signatures: b.outputs.map(sign) }); }
    if (p === "/v1/checkstate") { const b = JSON.parse(String(init?.body ?? "{}")); return json({ states: (b.Ys ?? []).map((Y: string) => ({ Y, state: "UNSPENT", witness: null })) }); }
    return json({ detail: "not found" }, 404);
  }
  return { id, base, handle, swaps, fakeProofs };
}
