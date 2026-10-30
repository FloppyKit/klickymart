import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { EMBEDDED_EVENTS_NDJSON } from "../src/fixture-data";
import { buildKlickymartWellKnown, buildNostrWellKnown, parseRelayUrls } from "../src/agent-capabilities";
import { buildSummaryJson } from "../src/summary-json";
import { NOSTR_KIND_CRAWL_RECORD } from "../src/nostr-kinds";
import wranglerToml from "../../wrangler.toml?raw";

const CRAWLER_HEX = "3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242";
const CRAWLER_NPUB = "npub1qqavgj7er49q23zq8gxlunkug6xq7ns7ez3x72e0tr5hn2lrf5eyy6ma2cd";

async function embeddedSnapshot() {
  const { rows } = await ingestFromNdjsonText(EMBEDDED_EVENTS_NDJSON, {
    verifyEvents: true,
    allowSynthetic: false,
    contentHash: "agent-access-test",
  });
  return rowsToSnapshot([...rows.values()], "events-test", "nostr");
}

describe("agent capabilities (embedded events)", () => {
  it("well-known klickymart lists endpoints, schema, relays, npub only", async () => {
    const snap = await embeddedSnapshot();
    const doc = buildKlickymartWellKnown("https://klickymart.com", snap, {
      contact: "bot@klickymart.com",
      relayUrlsRaw: "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net",
    }) as {
      record_schema_version: string;
      nostr_kinds: { crawl_record: number };
      endpoints: Record<string, string>;
      relays: string[];
      crawler: { npub: string };
    };
    expect(doc.record_schema_version).toBe("0.5-draft");
    expect(doc.nostr_kinds.crawl_record).toBe(NOSTR_KIND_CRAWL_RECORD);
    expect(doc.endpoints["/q"]).toBe("https://klickymart.com/q");
    expect(doc.endpoints["/summary.json"]).toBe("https://klickymart.com/summary.json");
    expect(doc.relays).toEqual(["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]);
    expect(doc.crawler.npub).toBe(CRAWLER_NPUB);
    expect(JSON.stringify(doc)).not.toContain(CRAWLER_HEX);
  });

  it("nostr.json maps bot to crawler hex", async () => {
    const snap = await embeddedSnapshot();
    const nip05 = buildNostrWellKnown(snap);
    expect(nip05.names.bot).toBe(CRAWLER_HEX);
  });

  it("summary.json counts by status and btc grade", async () => {
    const snap = await embeddedSnapshot();
    const summary = buildSummaryJson(snap);
    expect(summary.records).toBe(363);
    expect(summary.by_status.crawled).toBeGreaterThan(0);
    expect(summary.by_btc_grade["0"]).toBeGreaterThanOrEqual(0);
    expect(summary.version).toBe("events-test");
    expect(summary.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("agent routes (worker integration)", () => {
  it("GET /.well-known/klickymart.json", async () => {
    const res = await SELF.fetch("https://example.com/.well-known/klickymart.json");
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      endpoints?: { query?: string; summary?: string };
      record_schema_version?: string;
      relays?: string[];
      license?: { data?: { spdx?: string } };
    };
    expect(j.record_schema_version).toBe("0.5-draft");
    expect((j.endpoints as Record<string, string> | undefined)?.["/summary.json"]).toContain("/summary.json");
    expect(j.relays?.length).toBeGreaterThan(0);
    expect(j.license?.data?.spdx).toBe("CC0-1.0");
  });

  it("GET /summary.json", async () => {
    const res = await SELF.fetch("https://example.com/summary.json");
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      records: number;
      by_status: Record<string, number>;
      by_btc_grade: Record<string, number>;
    };
    expect(j.records).toBeGreaterThan(0);
    expect(typeof j.by_status).toBe("object");
    expect(j.by_btc_grade).toHaveProperty("ungraded");
  });

  it("GET /q short filter link returns JSON", async () => {
    const res = await SELF.fetch("https://example.com/q?btc=2&guest=1&pay=lightning&limit=5", {
      headers: { Accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { count: number; items: unknown[] };
    expect(j.count).toBeLessThanOrEqual(5);
    expect(Array.isArray(j.items)).toBe(true);
  });

  it("GET /q returns HTML when Accept is text/html", async () => {
    const res = await SELF.fetch("https://example.com/q?btc=2&guest=1&pay=lightning&limit=3", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Query results");
    expect(html).toContain("km-table");
  });

  it("GET /docs/relay-filters documents REQ recipes", async () => {
    const res = await SELF.fetch("https://example.com/docs/relay-filters");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Relay REQ filters");
    expect(html).toContain("status:crawled");
    expect(html).toContain("pay:ln");
    expect(html).toContain(String(NOSTR_KIND_CRAWL_RECORD));
  });

  it("GET /export.ndjson returns NDJSON stream", async () => {
    const res = await SELF.fetch("https://example.com/export.ndjson?limit=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("ndjson");
    const text = await res.text();
    expect(text.trim().split("\n").length).toBeGreaterThanOrEqual(1);
  });

  it("POST /mcp tools/list", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result?: { tools?: unknown[] } };
    expect(j.result?.tools?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("wrangler production config", () => {
  it("declares klickymart.com custom domains for production deploy", () => {
    const toml = wranglerToml;
    expect(toml).toContain("[env.production]");
    expect(toml).toContain('pattern = "klickymart.com"');
    expect(toml).toContain("custom_domain = true");
    expect(toml).toContain('pattern = "www.klickymart.com"');
    expect(toml).toContain("RELAY_URLS");
    expect(toml).not.toContain("relay.klickymart.com");
    expect(toml).toContain('RELAY_URLS = "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net"');
  });
});

describe("relay url parsing", () => {
  it("falls back to public relays and parses comma lists", () => {
    expect(parseRelayUrls(undefined)).toEqual(["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]);
    expect(parseRelayUrls("wss://relay.damus.io,wss://nos.lol, wss://relay.primal.net")).toEqual([
      "wss://relay.damus.io",
      "wss://nos.lol",
      "wss://relay.primal.net",
    ]);
  });
});
