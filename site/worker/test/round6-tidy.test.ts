/** GO-KM-R6-TIDY N2: GET /offers and MCP find_offers apply pay= BEFORE the page limit, so count, total and items all
 * describe the filtered set. The fixture here has 35 offers matching q=value; the only store observed taking Link ranks
 * 35th (last) by price, i.e. past the first page, and must still come back on page 1 with total 1. Unfiltered /offers is
 * unchanged (no pay_filter block, the same rank page), and the same request with an empty pay= is byte-identical. */
import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { bootstrapFixtures } from "../src/router";

/** A minimal crawl record in the shape data/records.ndjson uses (only the fields these assertions need). */
const rec = (d: string, pay: string[]) =>
  JSON.stringify({
    d, cat: ["gen"], v: "0.3-draft", ts: 1793292000, ua: "KlickyBot/0.2 (+https://klickymart.com/bot)",
    vantage: { ip: "single-datacenter", n: "test fixture" }, status: "crawled", name: d, name_ev: `https://${d}/`,
    ag: 1, co: 1, steps: 3, guest: 1, kyc: "none-stated", tos: "ok", tos_url: `https://${d}/terms`, ar: [],
    pay, pay_no: [], pay_q: pay.map((c) => ({ c, neg: false, url: `https://${d}/pay`, q: `Accepts ${c}.`, conf: "med", scope: "online" })),
    pay_online: pay, pay_instore: [], pay_unscoped: [], pay_src: "rendered-pages", evu: [`https://${d}/pay`],
    btc: 0, btc_any: false, btc_conf: "med", conf: "med",
  });

type OffersBody = { count: number; total: number; items: { domain: string; store: { pay: string[] | null } | null }[]; pay_filter?: { pay: string[]; note: string }; empty_note?: unknown };

const getJson = async <T>(p: string) => (await (await SELF.fetch(`https://example.com${p}`)).json()) as T;
const getText = async (p: string) => (await SELF.fetch(`https://example.com${p}`)).text();
const mcp = async (name: string, args: Record<string, unknown>) =>
  (await (await SELF.fetch("https://example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as { result?: { structuredContent: Record<string, unknown> }; error?: { message: string } };

describe("GO-KM-R6-TIDY N2: pay= filters before limit/offset (GET /offers and MCP find_offers)", () => {
  it("the only pay=link match ranks past the first page and still comes back on page 1 with total 1", async () => {
    // bitrefill.com has 34 offers matching q=value (priced 5..), rsfarmnc.com the only other match at $1000, so it ranks last.
    await env.DB.prepare("DELETE FROM records").run();
    await bootstrapFixtures(env as never, [rec("bitrefill.com", ["card", "pp"]), rec("rsfarmnc.com", ["link"])].join("\n"));

    // Unfiltered: unchanged rank page, no pay_filter block. This is the "byte-identical before and after" side: nothing
    // about the pay-less path moved (same items, same count/total, no extra fields).
    const unfiltered = await getJson<OffersBody>("/offers?q=value&limit=10");
    expect(unfiltered.count).toBe(10);
    expect(unfiltered.total).toBe(35);
    expect(unfiltered).not.toHaveProperty("pay_filter");
    expect(unfiltered).not.toHaveProperty("empty_note");
    expect(unfiltered.items.some((i) => i.domain === "rsfarmnc.com")).toBe(false); // the Link store is past the first page
    expect(unfiltered.items.every((i) => i.store?.pay?.includes("card") === true)).toBe(true);
    // an empty pay= is the no-filter path, byte for byte
    expect(await getText("/offers?q=value&limit=10&pay=")).toBe(await getText("/offers?q=value&limit=10"));

    // Filtered: count, total and items all describe the filtered set, and the match is on page 1 of 1.
    const filtered = await getJson<OffersBody>("/offers?q=value&limit=10&pay=link");
    expect(filtered.total).toBe(1);
    expect(filtered.count).toBe(1);
    expect(filtered.items.map((i) => i.domain)).toEqual(["rsfarmnc.com"]);
    expect(filtered.pay_filter?.pay).toEqual(["link"]);
    expect(filtered.pay_filter?.note).toMatch(/before limit/);
    expect(filtered).not.toHaveProperty("empty_note");

    // Same code path through MCP: identical filtered set.
    const m = await mcp("find_offers", { q: "value", pay: "link", limit: 10 });
    if (m.error) throw new Error(m.error.message);
    const sc = m.result!.structuredContent as unknown as OffersBody;
    expect(sc.total).toBe(1);
    expect(sc.count).toBe(1);
    expect(sc.items.map((i) => i.domain)).toEqual(filtered.items.map((i) => i.domain));
    expect(sc.pay_filter?.pay).toEqual(["link"]);

    // A code no store was observed taking keeps nothing (unknown, never assumed), with total 0 and an empty page.
    const unknownCode = await getJson<OffersBody>("/offers?q=value&limit=10&pay=spay");
    expect(unknownCode.total).toBe(0);
    expect(unknownCode.items).toEqual([]);
    expect(unknownCode).not.toHaveProperty("empty_note");
  });
});
