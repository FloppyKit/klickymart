/** K10-001 regression (Klicky Audit): two brand-new keys with owner-minted, never-paid "verified-preimage" notes took a
 * store to chart score 100. No proof may skip the key-age gate; verified-preimage is not a payment proof; owner keys never rank. */
import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { loadAggregates, proofWeight } from "../src/experience";

const D = "store.google.com";
const today = new Date().toISOString().slice(0, 10);
async function note(id: string, pk: string, day: string, proof_status = "verified-preimage") {
  await env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,depth,content,raw_json,source,received_day,basis,proof,proof_status) VALUES (?,422,?,?,?,1,'paid','',?,'post',?,'visit','preimage',?)")
    .bind(id, D, pk, Math.floor(Date.now() / 1000), "{}", day, proof_status).run();
}
const chartRow = async () => ((await (await SELF.fetch("https://example.com/chart.json?limit=500")).json()) as { items: { d: string; rank: number; score: number; score_source: string }[] }).items.find((x) => x.d === D);
beforeEach(async () => { for (const t of ["experiences", "nostr_events", "claims"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("K10-001: owner-minted preimage proofs can't take the chart", () => {
  it("two brand-new keys with verified-preimage paid notes do not move the chart", async () => {
    const before = await chartRow();
    await note("a1".repeat(32), "c1".repeat(32), today); await note("a2".repeat(32), "c2".repeat(32), today);
    expect((await loadAggregates(env.DB, [D])).get(D)).toBeUndefined();
    const after = await chartRow();
    expect(after?.score_source).toBe(before?.score_source); expect(after?.score).toBe(before?.score); expect(after?.rank).toBe(before?.rank);
    expect(after?.score).not.toBe(100);
  });
  it("after the gate, verified-preimage weighs like a plain note and is not a purchase proof", async () => {
    await note("a3".repeat(32), "c3".repeat(32), "2026-01-01"); await note("a4".repeat(32), "c4".repeat(32), "2026-01-01");
    const a = (await loadAggregates(env.DB, [D])).get(D)!;
    expect(a.keys).toBe(2); expect(a.verified_purchase_share).toBe(0); expect(a.proof_keys).toBe(0);
    expect(proofWeight("preimage", "verified-preimage")).toBe(1); expect(proofWeight(null, null)).toBe(1); expect(proofWeight("zap", "verified-zap")).toBe(1);
  });
  it("notes from the store's own claimed key never count, even when aged", async () => {
    const owner = "c5".repeat(32);
    await env.DB.prepare("INSERT INTO claims (d,pubkey,nip05,checked_at) VALUES (?,?,?,?)").bind(D, owner, `_@${D}`, 1).run();
    await note("a5".repeat(32), owner, "2026-01-01", "verified-zap"); await note("a6".repeat(32), "c6".repeat(32), "2026-01-01");
    const a = (await loadAggregates(env.DB, [D])).get(D)!;
    expect(a.keys).toBe(1); expect(a.owner_notes_excluded).toBe(1); expect(a.corroborated).toBe(false);
  });
  it("owner-minted zap receipts: brand-new keys don't move the chart; aged independent keys count only as plain notes", async () => {
    const before = await chartRow();
    await note("b1".repeat(32), "d1".repeat(32), today, "verified-zap"); await note("b2".repeat(32), "d2".repeat(32), today, "verified-zap");
    expect((await loadAggregates(env.DB, [D])).get(D)).toBeUndefined();
    const after = await chartRow(); expect(after?.score).toBe(before?.score); expect(after?.rank).toBe(before?.rank); expect(after?.score_source).toBe(before?.score_source);
    await env.DB.prepare("DELETE FROM experiences").run();
    await note("b3".repeat(32), "d3".repeat(32), "2026-01-01", "verified-zap"); await note("b4".repeat(32), "d4".repeat(32), "2026-01-01", "verified-zap");
    const a = (await loadAggregates(env.DB, [D])).get(D)!;
    expect(a.keys).toBe(2); expect(a.proof_keys).toBe(0); expect(a.verified_purchase_share).toBe(0);
  });
  it("owner-controlled key with a zap receipt never counts", async () => {
    const owner = "d5".repeat(32);
    await env.DB.prepare("INSERT INTO claims (d,pubkey,nip05,checked_at) VALUES (?,?,?,?)").bind(D, owner, `_@${D}`, 1).run();
    await note("b5".repeat(32), owner, "2026-01-01", "verified-zap");
    expect((await loadAggregates(env.DB, [D])).get(D)).toBeUndefined();
  });
});
