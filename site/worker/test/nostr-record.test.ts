import { describe, it, expect } from "vitest";
import { parseRecordLine } from "../src/nostr-record-source";
import { NOSTR_KIND_CRAWL_RECORD } from "../src/nostr-kinds";

describe("Nostr31420 NDJSON", () => {
  it("parses plain record lines", () => {
    const rec = parseRecordLine('{"d":"a.com","status":"crawled","ts":1,"v":"0.3-draft"}');
    expect(rec?.d).toBe("a.com");
  });

  it("parses kind 31420 event content", () => {
    const event = {
      id: "abc",
      pubkey: "dead",
      sig: "beef",
      kind: NOSTR_KIND_CRAWL_RECORD,
      tags: [["d", "shop.test"], ["t", "shopping"], ["L", "nip-xx"]],
      content: JSON.stringify({
        d: "shop.test",
        status: "crawled",
        ts: 1793292000,
        v: "0.3-draft",
      }),
    };
    const rec = parseRecordLine(JSON.stringify(event));
    expect(rec?.d).toBe("shop.test");
    expect(rec?.event_id).toBe("abc");
    expect(rec?.pubkey).toBe("dead");
  });
});
