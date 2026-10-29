import { describe, it, expect } from "vitest";
import { normalize, rejectExampleUnlessAllowed } from "../src/normalize";
import sampleNdjson from "../../fixtures/records.sample.ndjson?raw";

const sampleLine = sampleNdjson.split("\n").find((l) => l.trim())!;

describe("normalize", () => {
  it("accepts fixture line", () => {
    const raw = JSON.parse(sampleLine);
    const r = normalize(raw, "file:test", 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.d).toBe("store.google.com");
      expect(r.row.pay_instore).toBeTruthy();
    }
  });

  it("rejects example domains unless allowed", () => {
    expect(rejectExampleUnlessAllowed("foo.example", false)).toMatch(/rejected/);
    expect(rejectExampleUnlessAllowed("foo.example", true)).toBeNull();
  });

  it("rejects bad status", () => {
    const r = normalize({ d: "x.com", status: "nope", ts: 1, v: "0.3-draft" }, "t", 1);
    expect(r.ok).toBe(false);
  });
});
