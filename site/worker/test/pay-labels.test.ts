import { describe, expect, it } from "vitest";
import { payLabel, uniquePayLabels } from "../src/records-api";

describe("pay chip labels", () => {
  it("keeps the BNPL provider so two providers are distinct chips", () => {
    expect(payLabel("bnpl:afterpay")).toBe("Buy now pay later (Afterpay)");
    expect(payLabel("bnpl:klarna")).toBe("Buy now pay later (Klarna)");
    expect(payLabel("card")).not.toContain("(");
  });
  it("dedupes a code listed both online and in-store", () => {
    expect(uniquePayLabels(["card", "bnpl:klarna", "card", "bnpl:klarna", "bnpl"])).toEqual(
      [payLabel("card"), "Buy now pay later (Klarna)", "Buy now pay later"]);
  });
});
