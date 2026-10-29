import { describe, it, expect } from "vitest";
import { NdjsonFileSource, ingestFromLines } from "../src/ingest";

describe("ingest", () => {
  it("rejects synthetic without flag", async () => {
    const line = JSON.stringify({ d: "x.example", status: "crawled", ts: 1, v: "0.3-draft" });
    const { report } = await ingestFromLines(new NdjsonFileSource(line).read(), { allowSynthetic: false });
    expect(report.upserted).toBe(0);
    expect(report.rejected[0]?.reason).toMatch(/example/);
  });

  it("idempotent version on same input", async () => {
    const line = JSON.stringify({ d: "idempotent.test", status: "crawled", ts: 1, v: "0.3-draft", ag: 1 });
    const a = await ingestFromLines(new NdjsonFileSource(line).read(), { allowSynthetic: false, contentHash: "abc" });
    const b = await ingestFromLines(new NdjsonFileSource(line).read(), { allowSynthetic: false, contentHash: "abc" });
    expect(a.report.version).toBe(b.report.version);
  });
});
