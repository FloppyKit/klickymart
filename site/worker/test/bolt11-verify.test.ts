import { describe, expect, it } from "vitest";
import * as secp from "@noble/secp256k1";
import { bytesToHex } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { verifyBolt11, decodeBolt11, encodeBolt11ForTest } from "../src/bolt11";

// A real mainnet invoice from the BOLT11 spec test vectors ("Please send $3 for a cup of coffee", 2500u).
const SPEC = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const SPEC_PAYEE = "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad";

describe("KM-001: BOLT11 node signature", () => {
  it("verifies the BOLT11 spec vector and recovers its payee", () => {
    const v = verifyBolt11(SPEC);
    expect(v?.payee).toBe(SPEC_PAYEE);
    expect(v?.payment_hash).toBe("0001020304050607080900010203040506070809000102030405060708090102");
  });
  it("rejects a self-made invoice with a zero signature (the audit repro) and a tampered one", () => {
    const ts = Math.floor(Date.now() / 1000); const w: number[] = [];
    for (let i = 6; i >= 0; i--) w.push(Math.floor(ts / 32 ** i) % 32);
    const hw = bech32.toWords(new Uint8Array(32).fill(0xab));
    const forged = bech32.encode("lnbc10u", [...w, 1, Math.floor(hw.length / 32), hw.length % 32, ...hw, ...new Array(104).fill(0)], 10_000);
    expect(decodeBolt11(forged)).not.toBeNull(); // the display decoder still reads it
    expect(verifyBolt11(forged)).toBeNull();
    const sk = secp.utils.randomSecretKey();
    const good = encodeBolt11ForTest(sk, "lnbc10u", "cd".repeat(32));
    expect(verifyBolt11(good)?.payee).toBe(bytesToHex(secp.getPublicKey(sk)));
    const dec = bech32.decode(good as `${string}1${string}`, 10_000); const words = [...dec.words]; words[12] = (words[12]! + 1) % 32;
    const tampered = bech32.encode(dec.prefix, words, 10_000);
    expect(verifyBolt11(tampered)?.payee).not.toBe(bytesToHex(secp.getPublicKey(sk)));
  });
});
