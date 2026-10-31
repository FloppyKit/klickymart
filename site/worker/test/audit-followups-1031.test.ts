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

describe("#16/#38 protocols", () => {
  it("/q protocol filter and protocolsOf agree; declared UCP capabilities are shown", async () => {
    const { protocolsOf, hasProtocol } = await import("../src/protocols");
    const { UCP_CAPS } = await import("../src/ucp-caps");
    const main = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, verifyEvents: false, sourceLabel: "t" });
    const an = await ingestFromNdjsonText(AN as string, { allowSynthetic: false, verifyEvents: false, sourceLabel: "t-an" });
    clearAgentNative(); mergeAgentNative(main.rows, an.rows);
    const snap = rowsToSnapshot([...main.rows.values()], main.report.version, main.report.source);
    const v = validateQueryParams(new URLSearchParams("protocol=ucp&limit=500")); if (!v.ok) throw new Error(v.message);
    const items = (querySnapshot(snap, v.params) as any).items as any[];
    expect(items.length).toBeGreaterThan(10);
    for (const it of items.slice(0, 20)) { const row = snap.rows.find((r) => r.d === it.d)!; expect(hasProtocol(protocolsOf(row.d, JSON.parse(row.raw_json)), "ucp")).toBe(true); }
    const dec = Object.entries(UCP_CAPS).find(([, c]) => c.ok);
    if (dec) { const row = snap.rows.find((r) => r.d === dec[0]); if (row) { const p = protocolsOf(row.d, JSON.parse(row.raw_json)) as any; expect(p.ucp.status).toBe("declared"); expect(p.ucp.capabilities.length).toBeGreaterThan(0); } }
    expect(validateQueryParams(new URLSearchParams("protocol=ap3")).ok).toBe(false);
    const ac = snap.rows.find((r) => anOfRails(r.d));
    function anOfRails(d: string) { return (anJson(d) as any)?.rails?.includes?.("acp"); }
    if (ac) expect((protocolsOf(ac.d, JSON.parse(ac.raw_json)) as any).acp.status).toBe("claimed");
  });
});

describe("#34/#35/#32 template and Link copy", () => {
  it("warns on directory depth, not-observed at payment, and no narrative; help documents depth", async () => {
    const { experienceTemplate } = await import("../src/experience");
    const t = experienceTemplate({ domain: "bose.com", basis: "directory", depth: "checkout" }, null);
    expect(t.ok && (t.value.warnings as string[]).join(" ")).toMatch(/basis=directory \(no visit\) with depth "checkout"/);
    const u = experienceTemplate({ domain: "bose.com", basis: "visit", depth: "payment", shown_before_payment: "not-observed", narrative: "x" }, null);
    expect(u.ok && (u.value.warnings as string[]).join(" ")).toMatch(/not-observed at depth "payment"/);
    expect(u.ok && (u.value.warnings as string[]).join(" ")).not.toMatch(/no narrative/);
    const r = await (await SELF.fetch("https://klickymart.com/report/template?domain=bose.com&basis=visit&depth=browse")).json<any>();
    expect(r.param_help.depth).toMatch(/furthest step YOU reached/);
    expect(r.param_help.narrative).toMatch(/free text/);
  });
  it("/q?pay=link with no results explains one-time Link cards", async () => {
    const b = await (await SELF.fetch("https://klickymart.com/q?pay=link&reachable=1")).json<any>();
    if (b.total === 0) expect(b.empty_note.try).toMatch(/pay=card/);
  });
});

describe("POST /reviews only accepts validly signed events (script UAs are allowed past BIC only here)", () => {
  it("rejects unsigned, tampered and bad-sig bodies; accepts a signed dry run", async () => {
    const good = sign([["r", "unindexed-shop-example.com"], ["basis", "directory"], ["rating", "3", "5"]]);
    const { id, sig, ...unsigned } = good;
    for (const [name, body] of [["unsigned", unsigned], ["no sig", { ...good, sig: undefined }], ["bad sig", { ...good, sig: "0".repeat(128) }], ["tampered", { ...good, content: "changed" }], ["junk", { hello: "world" }]] as const) {
      const r = await post(body);
      expect(r.status, name).toBe(400);
      expect((await r.json<any>()).ok, name).toBe(false);
    }
    expect((await post(good)).status).toBe(200);
  });
});

describe("UCP quote profile", () => {
  it("declares checkout but no payment handlers, and says it never completes", async () => {
    const { handleRequest } = await import("../src/router");
    const { env } = await import("cloudflare:test");
    const r = await handleRequest(new Request("https://klickymart.com/ucp/quote-profile.json"), env as never);
    const j = (await r.json()) as { ucp: { capabilities: Record<string, unknown>; payment_handlers: Record<string, unknown> }; use: string };
    expect(j.ucp.capabilities["dev.ucp.shopping.checkout"]).toBeTruthy();
    expect(Object.keys(j.ucp.payment_handlers)).toHaveLength(0);
    expect(j.use).toMatch(/never completes/);
  });
});
