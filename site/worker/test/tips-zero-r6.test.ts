/** GO-KM-TIPS-ZERO-R6 Part A: tip weight is 0 (M1 rule 5, Matt 2026-10-31). Until M2 buyer-trust exists, b(t) is not
 * available, so tips are DISPLAY ONLY: counts, sats and tippers are still shown, but a note's ranking weight never changes.
 * These tests pin the rule and the rules text (Kerckhoffs: the served rules must say what the code does). */
import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, type Ev, type IngestCtx } from "../src/relay-ingest";
import { encodeBolt11ForTest } from "../src/bolt11";
import { loadTips, summarize, tipWeight, TIP_WEIGHT } from "../src/tips";
import { loadAggregates } from "../src/experience";

const D = "store.google.com";
const OUR = "3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242"; // secret-scan: allow (public pubkey)
const ctx = (): IngestCtx => ({ domains: new Set([D]), ourPubkey: OUR });
const key = () => secp.utils.randomSecretKey();
const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
function sign(sk: Uint8Array, kind: number, tags: string[][], content = "", created_at = Math.floor(Date.now() / 1000)): Ev {
  const base = { pubkey: pk(sk), created_at, kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const NODE = key();
/** A proper NIP-57 receipt: node-signed invoice whose description_hash commits to the 9734 request (same shape as facilitate-tips). */
function zap(lnurlSk: Uint8Array, payerSk: Uint8Array, note: { id: string; pubkey: string }): Ev {
  const req = sign(payerSk, 9734, [["p", note.pubkey], ["e", note.id], ["amount", "1000000"], ["relays", "wss://r.test"]]);
  const desc = JSON.stringify(req);
  const inv = encodeBolt11ForTest(NODE, "lnbc10u", bytesToHex(sha256(new TextEncoder().encode(req.id + "x"))), { descriptionHashHex: bytesToHex(sha256(new TextEncoder().encode(desc))) });
  return sign(lnurlSk, 9735, [["p", note.pubkey], ["e", note.id], ["bolt11", inv], ["description", desc], ["P", req.pubkey]]);
}
const lnurlFetcher = (nostrPubkey: string) => (async () => Response.json({ allowsNostr: true, nostrPubkey, callback: "https://ln.example/cb" })) as never;
const AGED_DAY = "2026-01-01"; // received_day far outside the 7-day key-age gate
const chartRow = async () => ((await (await SELF.fetch("https://example.com/chart.json?limit=500")).json()) as { items: { d: string; rank: number; score: number; score_source: string }[] }).items.find((x) => x.d === D);

/** An aged, counted visit note (basis=visit, depth=paid) exactly as the crawler/agent pipeline would have stored it. */
async function agedNote(id: string, pubkey: string) {
  await env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,depth,content,raw_json,source,received_day,basis) VALUES (?,422,?,?,?,1,'paid','',?,'post',?,'visit')")
    .bind(id, D, pubkey, Math.floor(Date.now() / 1000), "{}", AGED_DAY).run();
}
/** A tipper KlickyMart has held for 60+ days (bonus-eligible history), with unrelated public activity. */
async function agedTipper(t: Uint8Array) {
  await env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)")
    .bind(bytesToHex(key()), 1, pk(t), 1, null, "{}", Math.floor(Date.now() / 1000) - 60 * 86400, "wss://r.test").run();
}

beforeEach(async () => {
  for (const t of ["nostr_events", "site_records", "ingest_state", "reviews", "experiences", "claims", "lnurl_cache", "note_flags"]) {
    try { await env.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
  }
});

describe("GO-KM-TIPS-ZERO-R6 A: tip weight 0 (M1 rule 5)", () => {
  it("tipWeight() is 1 for every input, and TIP_WEIGHT says it is not in effect", () => {
    for (const n of [0, 1, 2, 5, 50]) expect(tipWeight(n)).toBe(1);
    expect(TIP_WEIGHT.IN_EFFECT).toBe(false);
    expect(TIP_WEIGHT.WEIGHT).toBe(0);
  });

  it("5 validated aged bonus tippers on a note leave the chart score and rank identical", async () => {
    const a = key(), b = key(), lnurl = key();
    const n1 = sign(a, 422, [["r", D], ["depth", "paid"], ["basis", "visit"], ["rating", "5", "5"], ["attempt", "paid"]], "paid with lightning, 3 steps");
    const n2 = sign(b, 422, [["r", D], ["depth", "checkout"], ["basis", "visit"], ["rating", "2", "5"], ["attempt", "checkout"]], "checkout stalled on the address form");
    await agedNote(n1.id, pk(a)); await agedNote(n2.id, pk(b));
    const prof = sign(a, 0, [], JSON.stringify({ lud16: "a@ln.example" }));
    await ingestEvents(env.DB, [{ ev: prof, relay: "wss://r.test" }], ctx());
    const before = await chartRow();
    expect(before).toBeDefined();
    expect(before!.score_source).toBe("community"); // the store's score really does come from these notes
    const aggBefore = (await loadAggregates(env.DB, [D])).get(D)!;
    expect(aggBefore.keys).toBe(2);

    // five bonus tippers: 21+ sats, validated receipt, key with 60-day history
    const tippers = Array.from({ length: 5 }, key);
    for (const t of tippers) await agedTipper(t);
    const receipts = tippers.map((t) => zap(lnurl, t, n1));
    const res = await ingestEvents(env.DB, receipts.map((ev) => ({ ev, relay: "wss://r.test" })), { ...ctx(), fetcher: lnurlFetcher(pk(lnurl)) });
    expect(res.accepted).toBe(receipts.length);

    // display is unchanged: all five tips are counted and reported
    const s = summarize((await loadTips(env.DB, D)).byNote.get(n1.id)!);
    expect(s).toMatchObject({ tips: 5, sats: 5000, distinct_tippers: 5, validated_tippers: 5, bonus_tippers: 5, self_zaps_ignored: 0, weight: 1 });

    // ranking is unchanged: same score, same rank, same source
    const after = await chartRow();
    expect(after!.score).toBe(before!.score);
    expect(after!.rank).toBe(before!.rank);
    expect(after!.score_source).toBe(before!.score_source);
    const aggAfter = (await loadAggregates(env.DB, [D])).get(D)!;
    expect(aggAfter.success_score).toBe(aggBefore.success_score);
    expect(aggAfter.tips).toMatchObject({ tips: 5, sats: 5000, bonus_tippers: 5, weight: 1 });
  });

  it("the served rules say tips add no ranking weight (no min(0.5 / +50% anywhere)", async () => {
    const tips = (await (await SELF.fetch(`https://example.com/tips.json?domain=${D}`)).json()) as { weight_rule: string; bonus_rules: Record<string, unknown> };
    expect(tips.weight_rule).toBe("tips add no ranking weight (0) until buyer-trust exists; shown only");
    expect(String(tips.bonus_rules.cap)).toMatch(/not in effect/);
    expect(tips.bonus_rules.in_effect).toBe(false);
    expect(tips.bonus_rules.tip_weight).toBe(0);
    const llms = await (await SELF.fetch("https://example.com/llms.txt")).text();
    for (const text of [JSON.stringify(tips), llms]) {
      expect(text).not.toContain("min(0.5");
      expect(text).not.toContain("+50%");
    }
    expect(llms).toContain("Tips are shown but add no ranking weight");
    // the site-tip line only renders when a site Lightning address is configured; its "never affects rankings" stays.
    if (llms.includes("Tip KlickyMart")) expect(llms).toContain("never affects rankings");
    const chart = (await (await SELF.fetch("https://example.com/chart.json?limit=5")).json()) as { method: string };
    expect(chart.method).toContain("tips add no ranking weight");
    expect(chart.method).not.toContain("tip multiplier");
    // /check carries the same "how" line (community.tips) and must not promise a boost either
    const chk = await (await SELF.fetch(`https://example.com/check?domain=${D}`)).text();
    expect(chk).not.toContain("+50%");
  });
});
