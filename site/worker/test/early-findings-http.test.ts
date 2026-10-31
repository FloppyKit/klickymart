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

describe("F5 documented /report example works", () => {
  it("the /report page example URL returns 200, and guest=yes is accepted", async () => {
    const h = await (await SELF.fetch("https://example.com/report")).text();
    const m = h.match(/GET https?:\/\/[^/]+(\/report\/template\?[^<]+)<\/code>/);
    expect(m).toBeTruthy();
    const r = await SELF.fetch("https://example.com" + m![1].replace(/&amp;/g, "&"));
    expect(r.status).toBe(200);
    const y = await SELF.fetch("https://example.com/report/template?domain=example.com&depth=payment&guest=yes&pay_used=ln");
    expect(y.status).toBe(200);
    expect(((await y.json()) as { fields: { guest: boolean } }).fields.guest).toBe(true);
  });
});

describe("F6 /landed max_landed (delivered total) vs max_price (item price)", () => {
  const L = (qs: string) => SELF.fetch(`https://example.com/landed?zip=66061&${qs}`).then((r) => r.json<any>());
  it("max_price is labelled item-only; max_landed filters on est_total", async () => {
    const all = await L("q=skull");
    expect(all.max_price_applies_to).toMatch(/item price only/);
    const t = all.items[0].landed.est_total as number;
    expect(t).toBeGreaterThan(all.items[0].price); // delivered total above item price
    // item price is under the budget, but the delivered total is not: max_price keeps it, max_landed drops it
    const budget = Math.floor(t) - 1;
    expect(all.items[0].price).toBeLessThan(budget);
    expect((await L(`q=skull&max_price=${budget}`)).count).toBe(1);
    const j = await L(`q=skull&max_landed=${budget}`);
    expect(j.count).toBe(0);
    expect(j.dropped_by_max_landed).toEqual({ over_budget: 1, total_unknown: 0 });
    expect((await L(`q=skull&max_landed=${Math.ceil(t)}`)).count).toBe(1);
  });
  it("rows with unknown delivered total are left out and counted", async () => {
    const all = await L("q=bose");
    const j = await L("q=bose&max_landed=10000");
    expect(j.count).toBe(all.items.filter((i: any) => typeof i.landed?.est_total === "number").length);
    expect(j.dropped_by_max_landed.total_unknown).toBe(all.count - j.count);
  });
  it("bad max_landed is a 400", async () => {
    expect((await SELF.fetch("https://example.com/landed?zip=66061&q=bose&max_landed=-5")).status).toBe(400);
  });
});
