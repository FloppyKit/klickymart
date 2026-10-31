import { describe, it, expect } from "vitest";
import { pendingKeyAllowance, PENDING_KEY_ALLOWANCE as C } from "../src/pending-allowance";
const now = 1_800_000_000, D = 86400;
describe("PQ-4 per-key pending allowance", () => {
  it("base for a new or unknown key", () => {
    expect(pendingKeyAllowance({ confirmedSales: 0, flagged: false }, now)).toBe(C.base);
    expect(pendingKeyAllowance({ firstSeenS: now - D, confirmedSales: 0, flagged: false }, now)).toBe(5);
  });
  it("grows by confirmed sales", () => {
    expect(pendingKeyAllowance({ firstSeenS: now, confirmedSales: 1, flagged: false }, now)).toBe(10);
    expect(pendingKeyAllowance({ firstSeenS: now, confirmedSales: 3, flagged: false }, now)).toBe(20);
  });
  it("tenure multiplier x2 at 7 days, x4 at 30 days", () => {
    expect(pendingKeyAllowance({ firstSeenS: now - 6 * D, confirmedSales: 1, flagged: false }, now)).toBe(10);
    expect(pendingKeyAllowance({ firstSeenS: now - 7 * D, confirmedSales: 1, flagged: false }, now)).toBe(20);
    expect(pendingKeyAllowance({ firstSeenS: now - 30 * D, confirmedSales: 1, flagged: false }, now)).toBe(40);
    expect(pendingKeyAllowance({ firstSeenS: now - 30 * D, confirmedSales: 0, flagged: false }, now)).toBe(20);
  });
  it("hard ceiling", () => {
    expect(pendingKeyAllowance({ firstSeenS: now - 365 * D, confirmedSales: 1000, flagged: false }, now)).toBe(C.ceiling);
    expect(C.ceiling).toBeLessThan(200);
  });
  it("any flag resets to base", () => {
    expect(pendingKeyAllowance({ firstSeenS: now - 365 * D, confirmedSales: 50, flagged: true }, now)).toBe(C.base);
  });
  it("reviews/tips are not inputs: extra fields change nothing", () => {
    const rec = { firstSeenS: now - 10 * D, confirmedSales: 2, flagged: false };
    const withVotes = { ...rec, reviewsReceived: 99, tipsReceived: 99, rating: 5 } as typeof rec;
    expect(pendingKeyAllowance(withVotes, now)).toBe(pendingKeyAllowance(rec, now));
  });
  it("garbage sales counts don't go negative", () => {
    expect(pendingKeyAllowance({ confirmedSales: -4, flagged: false }, now)).toBe(5);
  });
});
