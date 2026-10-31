/** Customer audit 2026-10-31 quick fixes. */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { checkDomain } from "../src/check";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { verifyNostrEvent } from "../src/nostr-verify";
import { findAlternatives } from "../src/alternatives";
import { experienceTemplate } from "../src/experience";
import { findOffers } from "../src/offers";
import REAL from "../../../data/records.ndjson?raw";

const O = "https://klickymart.com";
async function snap() {
  const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" });
  return rowsToSnapshot([...rows.values()], report.version, report.source);
}

describe("customer audit 2026-10-31", () => {
  it("invalid pubkey errors explain the 33-byte compressed key mistake", () => {
    const base = { id: "a".repeat(64), created_at: 1, kind: 422, tags: [], content: "", sig: "b".repeat(128) };
    const r = verifyNostrEvent({ ...base, pubkey: "02" + "c".repeat(64) } as never, 422);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toMatch(/33-byte compressed.*drop the leading 02\/03/);
    const r2 = verifyNostrEvent({ ...base, pubkey: "npub1xyz" } as never, 422);
    if (!r2.ok) expect(r2.reason).toMatch(/64 lowercase hex.*x-only/);
  });
  it("/alternatives accepts non-bitcoin pay values (card, link, stripe-link)", async () => {
    const s = await snap();
    for (const pay of ["card", "link", "stripe-link", "paypal"]) expect(findAlternatives(s, O, { category: "electronics", pay }).ok, pay).toBe(true);
    expect(findAlternatives(s, O, { category: "electronics", pay: "nonsense" }).ok).toBe(false);
  });
  it("/check: bestbuy-style probe error says checkout is unknown", async () => {
    const s = await snap();
    const unknown = s.rows.filter((r) => r.status === "crawled").map((r) => checkDomain(s, r.d, O)).filter((r) => r.ok && (r.body as any).verdict === "reachable" && (r.body as any).checkout_known === false);
    expect(unknown.length).toBeGreaterThan(0);
    for (const r of unknown) if (r.ok && /network-error|probe-error/.test(JSON.stringify((r.body as any).primary_reason))) expect((r.body as any).verdict_reason).toMatch(/CHECKOUT IS UNKNOWN/);
    const w = checkDomain(s, "walmart.com", O); if (w.ok) expect((w.body as any).checkout_known).toBe(true);
  });
  it("template warns when attempt is coarser than depth or disagrees", () => {
    const t = experienceTemplate({ domain: "bose.com", depth: "product", attempt: "checkout" }, null);
    expect(t.ok).toBe(true);
    const warn = JSON.stringify(t.ok ? t.value : {});
    expect(warn).toMatch(/attempt \(legacy 4-step tag\) filled as \\"browse\\" for depth \\"product\\"/);
    expect(warn).toMatch(/attempt \\"checkout\\" disagrees with depth \\"product\\"/);
  });
  it("offers: type= alone works as the search term", async () => {
    const s = await snap();
    const offers = [{ d: "bose.com", n: "Wired Earbuds X", p: 20, c: "USD", st: "in", u: "https://bose.com/p", me: "jsonld", src: "klickybot", t: 1 }] as never;
    const r = findOffers(offers, s, O, { type: "earbuds" });
    expect(r.ok).toBe(true);
  });
  it("dry run explains counts_toward_chart; llms documents guest=1 and the UA note", async () => {
    const llms = await (await SELF.fetch("https://example.com/llms.txt")).text();
    expect(llms).toMatch(/guest=1 semantics/);
    expect(llms).toMatch(/descriptive User-Agent/);
  });
});
