/** Dashboard human pass: each section answers one plain question with a visible denominator; BTC splits verified vs claimed. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const page = async () => (await SELF.fetch("https://example.com/dashboard")).text();

describe("dashboard human pass", () => {
  it("titles are plain questions and the BTC histogram is gone", async () => {
    const h = await page();
    for (const q of ["Can an agent get into these sites?", "Where can an agent pay with Bitcoin today?", "How far into a store does an agent get?", "Which payment methods do stores show?"]) expect(h).toContain(q);
    expect(h).not.toContain("Bitcoin grade histogram");
    expect(h).not.toContain("Bitcoin grade (all sites)");
  });
  it("bars show 'n of N' denominators", async () => {
    const h = await page();
    expect(h).toMatch(/class="km-bar-n">\d+ of \d+</);
  });
  it("BTC table lists real stores with links and a verified/claimed split that adds up", async () => {
    const h = await page();
    const rows = [...h.matchAll(/data-btc-store="([^"]+)" data-verified="([01])"/g)];
    expect(rows.length).toBeGreaterThan(0);
    const m = h.match(/<strong>(\d+) of (\d+)<\/strong> sites take Bitcoin or Lightning\. <strong>(\d+)<\/strong> verified[^]*?<strong>(\d+)<\/strong> claimed/);
    expect(m).not.toBeNull();
    const [, total, , ver, cl] = m!.map(Number);
    expect(total).toBe(rows.length);
    expect(ver + cl).toBe(total);
    expect(rows.filter((r) => r[2] === "1").length).toBe(ver);
    for (const [, d] of rows) expect(h).toContain(`/merchant/${d}`);
  });
});
