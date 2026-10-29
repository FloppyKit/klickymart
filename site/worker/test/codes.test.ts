import { describe, it, expect } from "vitest";
import { PAY_BIT, payCodeToBit, PAY_GROUPS } from "../src/codes";

describe("codes", () => {
  it("round-trips pay bits", () => {
    expect(payCodeToBit("card")).toBe(PAY_BIT.card);
    expect(payCodeToBit("bnpl:klarna")).toBe(PAY_BIT.bnpl);
  });

  it("pay groups are non-zero", () => {
    expect(PAY_GROUPS.bitcoin).toBeGreaterThan(0);
    expect(PAY_GROUPS.lightning).toBeGreaterThan(0);
    expect(PAY_GROUPS.ecash).toBeGreaterThan(0);
  });
});
