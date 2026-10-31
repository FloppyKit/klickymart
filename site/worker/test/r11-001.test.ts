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
