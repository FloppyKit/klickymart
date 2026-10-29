import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { NdjsonFileSource, ingestFromLines } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { querySnapshot, validateQueryParams } from "../src/query";
import sampleNdjson from "../../fixtures/records.sample.ndjson?raw";

let snap: ReturnType<typeof rowsToSnapshot>;

beforeAll(async () => {
  const { rows } = await ingestFromLines(new NdjsonFileSource(sampleNdjson).read(), { allowSynthetic: false });
  snap = rowsToSnapshot([...rows.values()], "test", "file");
});

describe("/q filters", () => {
  it("scope=online excludes in-store-only card", () => {
    const sp = new URLSearchParams("pay=card&scope=online");
    const v = validateQueryParams(sp);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = querySnapshot(snap, v.params);
    expect(r.items.some((i) => i.d === "store.google.com")).toBe(false);
  });

  it("scope=instore includes store.google.com", () => {
    const sp = new URLSearchParams("pay=card&scope=instore");
    const v = validateQueryParams(sp);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = querySnapshot(snap, v.params);
    expect(r.items.some((i) => i.d === "store.google.com")).toBe(true);
  });

  it("unknown param 400", async () => {
    const res = await SELF.fetch("https://example.com/q?nope=1");
    expect(res.status).toBe(400);
  });

  it("btc=null filter", () => {
    const sp = new URLSearchParams("btc=null");
    const v = validateQueryParams(sp);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const r = querySnapshot(snap, v.params);
    expect(r.items.every((i) => i.btc === null)).toBe(true);
  });

  it("sort nulls last for btc", () => {
    const r = querySnapshot(snap, { sort: ["-btc", "d"], limit: 50 });
    const grades = r.items.map((i) => i.btc);
    const nullIdx = grades.indexOf(null);
    const numIdx = grades.findIndex((g) => g !== null);
    if (nullIdx >= 0 && numIdx >= 0) expect(nullIdx).toBeGreaterThan(numIdx);
  });

  it("integration X-KM-Filter-Ms", async () => {
    const res = await SELF.fetch("https://example.com/q?limit=5");
    expect(res.headers.get("X-KM-Filter-Ms")).toBeTruthy();
  });

  it("includes license metadata", async () => {
    const res = await SELF.fetch("https://example.com/q?limit=1");
    const j = (await res.json()) as { license?: { data?: string } };
    expect(j.license?.data).toBe("CC0-1.0");
    expect(res.headers.get("X-KM-Data-License")).toBe("CC0-1.0");
  });

  it("accepts category=shopping", async () => {
    const res = await SELF.fetch("https://example.com/q?category=shopping&limit=5");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { count: number };
    expect(j.count).toBeGreaterThan(0);
  });

  it("rejects unknown category", async () => {
    const res = await SELF.fetch("https://example.com/q?category=travel");
    expect(res.status).toBe(400);
  });
});

describe("ingest ArrayRecordSource", () => {
  it("swaps source implementation", async () => {
    const { ArrayRecordSource } = await import("../src/ingest");
    const src = new ArrayRecordSource([JSON.parse(sampleLine())]);
    const { report } = await ingestFromLines(src.read(), { allowSynthetic: false });
    expect(report.upserted).toBe(1);
  });
});

function sampleLine() {
  return sampleNdjson.split("\n").find((l: string) => l.trim())!;
}
