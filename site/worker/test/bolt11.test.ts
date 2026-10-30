import { describe, expect, it } from "vitest";
import { decodeBolt11 } from "../src/bolt11";
// BOLT11 spec example ("Please send $5 for a cup of coffee"), 2500u
export const SPEC_INVOICE = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
describe("bolt11", () => {
  it("decodes amount and payment hash", () => {
    const r = decodeBolt11(SPEC_INVOICE);
    expect(r?.amount_msat).toBe(250_000_000);
    expect(r?.payment_hash).toBe("0001020304050607080900010203040506070809000102030405060708090102");
  });
  it("rejects junk", () => expect(decodeBolt11("lnbc1junk")).toBeNull());
});
