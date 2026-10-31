import { describe, expect, it } from "vitest";
import { findAlternatives } from "../src/alternatives";
import { storeCard } from "../src/store-card";
import { rowFlags } from "../src/row-flags";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import REAL from "../../../data/records.ndjson?raw";

async function realSnap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}
const O = "https://example.com";

describe("R11-001 checkout-blocked is consistent across surfaces", () => {
  it("store card and row flags say checkout-blocked for walmart.com (bot wall)", async () => {
    const snap = await realSnap();
    const card = storeCard(snap, "walmart.com") as Record<string, any>;
    expect(card.verdict).toBe("checkout-blocked");
    const f = rowFlags({ store: card } as any);
    expect(f.agent_usable).toBe(false);
    expect(f.flags.join(" ")).toMatch(/checkout-blocked/);
  });
  it("alternatives exclude blocked stores by default; include_blocked=1 lists them last", async () => {
    const snap = await realSnap();
    const a = findAlternatives(snap, O, { domain: "target.com", limit: 50 });
    if (!a.ok) throw new Error("alt failed");
    const b = a.body as any;
    expect(b.items.map((i: any) => i.d)).not.toContain("walmart.com");
    expect(b.blocked_excluded).toContain("walmart.com");
    expect(b.items.every((i: any) => i.verdict === "reachable")).toBe(true);
    const inc = findAlternatives(snap, O, { domain: "target.com", limit: 50, include_blocked: true });
    if (!inc.ok) throw new Error("alt failed");
    const items = (inc.body as any).items as { d: string; verdict: string }[];
    expect((inc.body as any).total).toBe(b.total + b.blocked_excluded.length);
    expect((inc.body as any).blocked_excluded).toEqual([]);
    const firstBlocked = items.findIndex((i) => i.verdict === "checkout-blocked");
    if (firstBlocked >= 0) expect(items.slice(firstBlocked).every((i) => i.verdict === "checkout-blocked")).toBe(true);
  });
});

describe("K12-101 /offers: blocked stores rank after usable ones regardless of match confidence", () => {
  it("a gtin match at a checkout-blocked store ranks below a name match at a usable store", async () => {
    const { findOffers } = await import("../src/offers");
    const snap = await realSnap();
    const mk = (d: string, extra: Record<string, unknown>) => ({ d, n: "Acme Widget Pro 3000", p: 10, c: "USD", st: "in", u: `https://${d}/p`, me: "jsonld", src: "klickybot", t: 1, ...extra });
    const offers = [mk("walmart.com", { g: "0123456789012" }), mk("target.com", {})] as never;
    const r = findOffers(offers, snap, O, { gtin: "0123456789012", q: "acme widget pro 3000" });
    if (!r.ok) throw new Error(r.message);
    expect(r.body.items.map((i) => i.domain)).toEqual(["target.com", "walmart.com"]);
    expect(r.body.items[1]!.match.conf).toBeGreaterThan(r.body.items[0]!.match.conf);
  });
});
