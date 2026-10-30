/** GO 5.7 round-1 (Deal Hunting) fixes. */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import routerSrc from "../src/router.ts?raw";
import { queryTokens, offerTokens } from "../src/search-terms";
import { findAlternatives } from "../src/alternatives";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { querySnapshot, validateQueryParams } from "../src/query";
import REAL from "../../../data/records.ndjson?raw";
let SNAP: ReturnType<typeof rowsToSnapshot> | null = null;
async function realSnap() {
  if (SNAP) return SNAP;
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return (SNAP = rowsToSnapshot([...rows.values()], report.version, report.source));
}
const q = async (qs: string) => { const p = validateQueryParams(new URLSearchParams(qs)); if (!p.ok) throw new Error(p.message); return querySnapshot(await realSnap(), p.params); };

const j = async (u: string) => (await SELF.fetch(`https://example.com${u}`)).json<Record<string, any>>();

describe("round-1 fixes", () => {
  it("taxpre=1: count/total agree with items, and unknown is explained", async () => {
    const r = await j("/alternatives?category=electronics&zip=66061&taxpre=1&limit=50");
    expect(r.total).toBe(r.items.length);
    expect(r.count).toBe(r.items.length);
    for (const it of r.items) expect(it.landed.tax_shown_before_payment).toBe(true);
    expect(r.taxpre.note).toMatch(/observed|unknown/);
    expect((await SELF.fetch("https://example.com/alternatives?category=electronics&taxpre=1")).status).toBe(400);
  });
  it("pay=btc means on-chain: every item's pay list contains btc", async () => {
    const a = findAlternatives(await realSnap(), "https://example.com", { category: "crypto-hardware", pay: "btc", limit: 50 });
    if (!a.ok) throw new Error();
    const r = a.body as { items: { d: string; pay: string[] }[] };
    expect(r.items.map((i) => i.d)).not.toContain("shop.trezor.io");
    expect(r.items.length).toBeGreaterThan(0);
    for (const it of r.items) expect(it.pay).toContain("btc");
  });
  it("every cat code in llms.txt is accepted by /q (btcnative)", async () => {
    const txt = await (await SELF.fetch("https://example.com/llms.txt")).text();
    const line = txt.split("\n").find((l) => l.includes("store-type codes"))!;
    const codes = line.match(/codes, comma-separated: ([^)]*)\)/)![1].split(", ");
    expect(codes).toContain("btcnative");
    for (const c of codes) expect((await SELF.fetch(`https://example.com/q?cat=${c}&limit=1`)).status, c).toBe(200);
    expect((await q("cat=btcnative&limit=50")).items.length).toBeGreaterThan(20);
  });
  it("every router path appears in openapi.json", async () => {
    const spec = await j("/openapi.json");
    const paths = new Set(Object.keys(spec.paths));
    const routes = [...routerSrc.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]);
    expect(routes.length).toBeGreaterThan(20);
    const missing = [...new Set(routes)].filter((p) => !paths.has(p));
    expect(missing).toEqual([]);
    for (const pre of [...routerSrc.matchAll(/path\.startsWith\("(\/[a-z]+\/)"\)/g)].map((m) => m[1]))
      expect([...paths].some((p) => p.startsWith(pre)), pre).toBe(true);
  });
  it("noise-cancelling / ANC / over-ear synonyms match offers and merchants", async () => {
    expect(queryTokens("noise-cancelling over-ear headphones")).toEqual(["anc", "overear", "headphones"].map((w) => w.replace(/s$/, "")));
    expect(offerTokens("QuietComfort Headphones", "Bose").has("anc")).toBe(true);
    for (const q of ["noise cancelling", "noise-cancelling headphones", "ANC headphones", "over-ear noise cancelling headphones"]) {
      const r = await j(`/offers?q=${encodeURIComponent(q)}`);
      expect(r.items.length, q).toBeGreaterThan(0);
    }
    expect((await q("q=noise%20cancelling%20headphones&limit=20")).items.map((i: { d: string }) => i.d)).toContain("bose.com");
  });
});
