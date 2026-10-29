import { describe, it, expect } from "vitest";
import { licenseMetaBlock, LICENSE_DATA, LICENSE_CODE } from "../src/license-meta";

describe("license metadata", () => {
  it("uses MIT and CC0-1.0", () => {
    const m = licenseMetaBlock();
    expect(m.license.code).toBe(LICENSE_CODE);
    expect(m.license.data).toBe(LICENSE_DATA);
    expect(m.license.data_url).toContain("creativecommons.org");
  });
});
