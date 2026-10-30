import { describe, it, expect } from "vitest";
import { verifyNostr31420Event } from "../src/nostr-verify";
import { ingestFromNdjsonText } from "../src/ingest";
import { EMBEDDED_EVENTS_NDJSON } from "../src/fixture-data";

describe("nostr verify", () => {
  it("accepts first signed embedded event", () => {
    const line = EMBEDDED_EVENTS_NDJSON.split("\n").find((l) => l.trim())!;
    const ev = JSON.parse(line);
    expect(verifyNostr31420Event(ev)).toEqual({ ok: true });
  });

  it("rejects tampered signature", () => {
    const line = EMBEDDED_EVENTS_NDJSON.split("\n").find((l) => l.trim())!;
    const ev = JSON.parse(line);
    ev.sig = "0".repeat(128);
    const r = verifyNostr31420Event(ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signature|bad/i);
  });

  it("ingests 250 verified embedded events", async () => {
    const { rows, report } = await ingestFromNdjsonText(EMBEDDED_EVENTS_NDJSON, {
      verifyEvents: true,
      allowSynthetic: false,
      contentHash: "test-events",
    });
    expect(rows.size).toBe(348);
    expect(report.rejected.length).toBe(0);
  });
});
