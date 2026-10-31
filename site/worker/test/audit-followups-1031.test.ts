/** Customer audit 2026-10-31 follow-ups (#4/#28 and later items). Throwaway local keys only; nothing is published. */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { beforeAll } from "vitest";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot, type Snapshot } from "../src/index-mem";
import { anJson, clearAgentNative, mergeAgentNative, railCheck } from "../src/agent-native";
import { querySnapshot, validateQueryParams } from "../src/query";
import REAL from "../../../data/events.ndjson?raw";
import AN from "../../../data/events.agent-native.ndjson?raw";

function sign(tags: string[][], kind = 422, content = "reached payment") {
  const sk = secp.utils.randomSecretKey();
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const post = (ev: unknown, dry = true) => SELF.fetch(`https://klickymart.com/reviews${dry ? "?dry_run=1" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) });

describe("#4/#28 notes about unindexed stores", () => {
  it("dry run accepts an unindexed public domain and marks it pending, not chart-counted", async () => {
    const r = await post(sign([["r", "unindexed-shop-example.com"], ["basis", "visit"], ["depth", "payment"], ["rating", "4", "5"]]));
    const b = await r.json<any>();
    expect(r.status).toBe(200);
    expect(b).toMatchObject({ ok: true, store_indexed: false, counts_toward_chart: false, stored: false });
    expect(b.pending_crawl.status).toBe("pending check");
    expect(b.store_note).toMatch(/robots\.txt first/);
  });
  it("still rejects junk hosts", async () => {
    for (const h of ["localhost", "10.0.0.1", "intranet"]) {
      const b = await (await post(sign([["r", h], ["depth", "browse"]]))).json<any>();
      expect(b.ok, h).toBe(false);
    }
  });
});

describe("#5/#33 paid-API rail checks", () => {
  let snap: Snapshot;
  beforeAll(async () => {
    const main = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, verifyEvents: false, sourceLabel: "t" });
    const an = await ingestFromNdjsonText(AN as string, { allowSynthetic: false, verifyEvents: false, sourceLabel: "t-an" });
    clearAgentNative(); mergeAgentNative(main.rows, an.rows);
    snap = rowsToSnapshot([...main.rows.values()], main.report.version, main.report.source);
  });
  const q = (s: string) => { const v = validateQueryParams(new URLSearchParams(s)); if (!v.ok) throw new Error(v.message); return querySnapshot(snap, v.params); };
  it("bolt11_no_browser=1 keeps only stores our probe saw issue an L402 bolt11 invoice", () => {
    const ds = (q("bolt11_no_browser=1&limit=500") as any).items.map((x: any) => x.d);
    expect(ds).toContain("satsdns.com");
    for (const d of ds) expect(railCheck(d)!.bolt11_no_browser.verified).toBe(true);
    expect(validateQueryParams(new URLSearchParams("bolt11_no_browser=yes")).ok).toBe(false);
  });
  it("flags a listed L402 with no real 402 and one with no endpoint", () => {
    expect(railCheck("sats4ai.com")?.listing_flag?.code).toBe("no-real-402");
    expect(railCheck("sats4ai.com")?.bolt11_no_browser.verified).toBe(false);
    expect(railCheck("arknode.ai")?.listing_flag?.code).toBe("no-endpoint");
    expect((anJson("satsdns.com") as any).bolt11_no_browser.verified).toBe(true);
  });
});
describe("#33 newer unsigned probe results", () => {
  it("agent402.tools: x402 verified 402 is not a bolt11 rail", async () => {
    const { ingestFromNdjsonText: ing } = await import("../src/ingest");
    const main = await ing(REAL as string, { allowSynthetic: false, verifyEvents: false, sourceLabel: "t" });
    const an = await ing(AN as string, { allowSynthetic: false, verifyEvents: false, sourceLabel: "t-an" });
    clearAgentNative(); mergeAgentNative(main.rows, an.rows);
    const rc = railCheck("agent402.tools");
    if (rc) { expect(rc.listing_flag).toBeNull(); expect(rc.bolt11_no_browser.verified).toBe(false); expect(String(rc.bolt11_no_browser.reason)).toMatch(/x402|no Lightning/); }
  });
});

describe("#21/#29/#31 store checkout quotes", () => {
  it("uses the store's own quote for shipping and tax instead of our estimate", async () => {
    const { landedFor } = await import("../src/landed");
    const raw = { ship: { ships_us: true, free_min_usd: null }, landed: { store_quotes: [{ state: "KS", subtotal: 21.99, shipping: 0, tax: 0, total: 21.99, method: "ucp-checkout", checked_at: "2026-10-31T05:43:00Z" }] } };
    const l = landedFor(raw, "66061", 21.99) as any;
    expect(l.est_tax).toBe(0); expect(l.shipping.usd).toBe(0); expect(l.est_total).toBe(21.99);
    expect(l.est_total_label).toBe("store-quoted shipping and tax"); expect(l.tax_source.method).toBe("store checkout quote");
    const e = landedFor({ ship: { ships_us: true } }, "66061", 21.99) as any;
    expect(e.est_total).toBeNull(); expect(e.ship_quote_note).toMatch(/no quote text|per-ZIP/);
  });
});
