import { describe, expect, it } from "vitest";
import { cleanRestrictions, cleanConflicts, sanitizeRawPolicies } from "../src/policy-shapes";
import { renderV5, policiesView } from "../src/explain";
import { normalize } from "../src/normalize";

const bad = {
  return_days: 30,
  return_restrictions: [null, 7, "x", { kind: 3, q: "a" }, { kind: "final-sale", q: "Clearance is final sale", url: "javascript:alert(1)" }, { kind: "opened", q: "15% fee", url: "https://s.example/r" }],
  conflicting_sources: [null, { days: "60", q: "a" }, { days: NaN, q: "b" }, { days: 14, q: "14 days on FAQ", url: "https://s.example/faq" }],
};

describe("R11-002 policy array shapes validated at ingest and render", () => {
  it("cleaners drop invalid entries and unsafe urls", () => {
    expect(cleanRestrictions(bad.return_restrictions)).toEqual([{ kind: "final-sale", q: "Clearance is final sale" }, { kind: "opened", q: "15% fee", url: "https://s.example/r" }]);
    expect(cleanConflicts(bad.conflicting_sources)).toEqual([{ days: 14, q: "14 days on FAQ", url: "https://s.example/faq" }]);
    expect(cleanRestrictions("nope")).toBeNull();
    expect(cleanConflicts([null])).toEqual([]);
  });
  it("render ([null] previously crashed /merchant) does not throw and shows only valid entries", () => {
    expect(() => renderV5({ policies: { return_restrictions: [null], conflicting_sources: [null] } })).not.toThrow();
    const html = renderV5({ policies: bad });
    expect(html).toContain("Clearance is final sale");
    expect(html).not.toContain("javascript:");
    expect(() => renderV5({ policies: "garbage" } as any)).not.toThrow();
    const v = policiesView({ policies: { return_restrictions: [null], conflicting_sources: { a: 1 } } })!;
    expect(v.return_restrictions).toEqual([]);
    expect(v.conflicting_sources).toBeNull();
  });
  it("ingest stores the cleaned shapes", () => {
    expect(sanitizeRawPolicies({ d: "a.com", policies: 5 })).toEqual({ d: "a.com" });
    const r = normalize({ d: "shop.example", v: "1", ts: 1761800000, status: "crawled", policies: bad } as any, "test", 1);
    if (!r.ok) throw new Error(r.reason);
    const raw = JSON.parse((r as any).row.raw_json);
    expect(raw.policies.return_restrictions).toHaveLength(2);
    expect(raw.policies.conflicting_sources).toHaveLength(1);
  });
});
