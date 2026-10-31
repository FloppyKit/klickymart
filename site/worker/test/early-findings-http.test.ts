/** Early AI-shopper findings 2026-10-30: HTTP-level checks (report defaults, guest aliases, docs examples). */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { experienceTemplate } from "../src/experience";

describe("F4 report defaults do not overclaim", () => {
  it("/report form has no preselected depth or visit basis; the example is a directory note", async () => {
    const h = await (await SELF.fetch("https://example.com/report")).text();
    expect(h).not.toMatch(/<option selected>checkout<\/option>/);
    expect(h).toMatch(/data-field="depth"><option value="" selected>/);
    expect(h).toMatch(/data-field="basis"><option value="" selected>/);
    expect(h).not.toContain('&quot;basis&quot;,\n  &quot;visit&quot;');
    expect(h).toMatch(/EXAMPLE ONLY/);
  });
  it("a template with no basis/depth is unknown and does not count toward the chart", () => {
    const t = experienceTemplate({ domain: "example.com" }, null);
    if (!t.ok) throw new Error(t.message);
    const v = t.value as { fields: { basis: string; counts_toward_chart: boolean; depth: unknown } };
    expect(v.fields.basis).toBe("unknown");
    expect(v.fields.counts_toward_chart).toBe(false);
    expect(v.fields.depth).toBeNull();
  });
});
