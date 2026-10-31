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

describe("F3 network-error staleness", () => {
  it("bestbuy.com: exposes newest_probe_failed, retry_after and last-good fields instead of a bare null", async () => {
    const b = body(checkDomain(await snap(), "bestbuy.com", O));
    const c = b.checkout_depth;
    expect(c.newest_probe_failed).toBe("network-error");
    expect(c.retry_after).toMatch(/^\d{4}-/);
    expect(c).toHaveProperty("last_successful_probe");
    expect(c).toHaveProperty("last_good_co");
    expect(c.staleness_note).toMatch(/network errors/);
  });
  it("uses checkout_map.last_good when the crawler carried it forward", async () => {
    const s = await snap();
    const row = s.rows.find((r) => r.d === "bestbuy.com")!;
    const raw = parseRaw(row.raw_json) as any;
    raw.checkout_map.last_good = { co: 2, stage: "checkout", guest: true, checked_at: "2026-10-20T00:00:00Z" };
    const { checkoutOf } = await import("../src/explain");
    const c = checkoutOf(row, raw) as any;
    expect(c.last_good_co).toBe(2);
    expect(c.last_successful_probe).toBe("2026-10-20T00:00:00Z");
    expect(c.staleness_note).toMatch(/last_good_co/);
  });
});

describe("F7 chart: crawl-observed rails are pay_seen, not pay_used", async () => {
  const { buildChart } = await import("../src/chart");
  it("with no community data, pay_used is null (community) and pay_seen carries the crawl list", async () => {
    const s = await snap();
    const ch = buildChart(s, new Map());
    const withPay = ch.items.find((i) => Array.isArray(i.values.pay_seen?.value) && (i.values.pay_seen!.value as string[]).length)!;
    expect(withPay).toBeTruthy();
    expect(withPay.values.pay_seen!.source).toBe("crawl");
    expect(withPay.values.pay_used!.value).toBeNull();
    expect(withPay.values.pay_used!.source).toBe("community");
    for (const i of ch.items) expect(i.values.pay_used!.source).toBe("community");
  });
});
