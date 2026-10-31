/** Early AI-shopper findings 2026-10-30 (Scout + Sherlock), checked against the real records. */
import { describe, expect, it } from "vitest";
import { checkDomain } from "../src/check";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { parseRaw } from "../src/records-api";
import { deriveVerdict } from "../src/explain";
import REAL from "../../../data/records.ndjson?raw";

const O = "https://klickymart.com";
async function snap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}
const body = (r: ReturnType<typeof checkDomain>) => { if (!r.ok) throw new Error(r.message); return r.body as Record<string, any>; };

describe("F1/F2 verdict never contradicts blocker or terms", () => {
  it("walmart.com: bot-wall blocker downgrades the verdict to checkout-blocked", async () => {
    const b = body(checkDomain(await snap(), "walmart.com", O));
    expect(b.checkout_map.first_blocker.kind).toBe("bot-wall");
    expect(b.verdict).toBe("checkout-blocked");
    expect(b.pages_reachable).toBe(true);
    expect(b.verdict_reason).toMatch(/bot-wall/);
    expect(b.primary_reason.source).toBe("checkout-probe");
  });
  it("amazon.com: terms are the primary reason, the probe blocker is secondary", async () => {
    const b = body(checkDomain(await snap(), "amazon.com", O));
    expect(b.primary_reason.source).toBe("terms");
    expect(b.primary_reason.kind).toBe("restricts-agents");
    expect(b.checkout_map.first_blocker.kind).toBe("no-checkout-button");
    expect(b.checkout_map.first_blocker.secondary).toBe(true);
  });
  it("audit: no crawled store reports verdict reachable with a bot-wall/http-refusal blocker", async () => {
    const s = await snap();
    for (const r of s.rows) {
      const raw = parseRaw(r.raw_json);
      const v = deriveVerdict(r, raw);
      const k = (raw.checkout_map as { first_blocker?: { kind?: string } } | undefined)?.first_blocker?.kind;
      if (v.verdict === "reachable" && !raw.agent_policy) expect(["bot-wall", "http-refusal"], r.d).not.toContain(k);
      if (r.status !== "crawled") expect(v.pages_reachable, r.d).toBe(false);
    }
  });
});
