import { describe, it, expect } from "vitest";
import { computeReachShare, computeBtcSunScore, reachToLandscapeFidelity } from "../src/landscape-metrics";
import type { IndexRow } from "../src/index-mem";

function row(partial: Partial<IndexRow> & { d: string }): IndexRow {
  return {
    idx: 0,
    status_code: 0,
    pay_no: 0,
    d: partial.d,
    name: partial.name ?? null,
    status: partial.status ?? "crawled",
    ag: partial.ag ?? 2,
    btc: partial.btc ?? null,
    btc_any: partial.btc_any ?? null,
    cat_mask: partial.cat_mask ?? 1,
    pay_any: partial.pay_any ?? 0,
    raw_json: partial.raw_json ?? "{}",
    ts: partial.ts ?? 1,
    ar_mask: 0,
    co: null,
    ease: null,
    guest: null,
    kyc: null,
    tos: null,
    pay_online: partial.pay_online ?? 0,
    pay_instore: 0,
    pay_unscoped: 0,
    search: partial.d,
  } as IndexRow;
}

describe("landscape metrics", () => {
  it("computes reach share", () => {
    const share = computeReachShare([
      row({ d: "a.com", ag: 2 }),
      row({ d: "b.com", ag: 0 }),
    ]);
    expect(share).toBe(0.5);
  });

  it("maps reach to fidelity 0-3", () => {
    expect(reachToLandscapeFidelity(0)).toBe(0);
    expect(reachToLandscapeFidelity(0.5)).toBe(1.5);
    expect(reachToLandscapeFidelity(1)).toBe(3);
  });

  it("weights private btc methods", () => {
    const score = computeBtcSunScore([
      row({
        d: "ln.shop",
        btc: 3,
        btc_any: 1,
        raw_json: JSON.stringify({ pay: ["ln", "cashu"], btcpriv: ["ecash"] }),
      }),
    ]);
    expect(score).toBeGreaterThan(0.5);
  });
});
