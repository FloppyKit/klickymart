import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import type { NostrEventLine } from "../src/handshake";
import { buildGraph, deriveBuys, deriveComplaints, loadTiers, npubToHex, resetTierCache, runTrustJob, tierFor, MIN_BUYERS, type RelayQuery, type TrustField } from "../src/trust-tier";
import { findOffers, type Offer } from "../src/offers";
import { rowsToSnapshot } from "../src/index-mem";

const SEED_NPUB = "npub132wd743y4jldsgy56k25zd7hl67g78zpl89drnnxt005qgm0mrjqfz25ah";
type Key = { sk: Uint8Array; pk: string };
const key = (): Key => { const sk = secp.utils.randomSecretKey(); return { sk, pk: bytesToHex(secp.schnorr.getPublicKey(sk)) }; };
let t0 = 1_793_400_000;
const sign = (k: Key, kind: number, tags: string[][], content = ""): NostrEventLine => {
  const ev = { pubkey: k.pk, created_at: t0++, kind, tags, content }; const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), k.sk)) };
};
const need = (b: Key) => sign(b, 420, [["t", "commerce"], ["amount", "40000000", "msat"], ["payment", "zap"]], "need");
const ful = (s: Key, n: NostrEventLine) => sign(s, 421, [["e", n.id, "", "need"], ["p", n.pubkey], ["proof", "tracking", "ups", "1Z9"]], "shipped");
const acc = (b: Key, f: NostrEventLine, n: NostrEventLine, extra: string[][] = []) => sign(b, 422, [["e", f.id, "", "fulfillment"], ["e", n.id, "", "need"], ["p", f.pubkey], ...extra], "thanks");
const thread = (b: Key, s: Key, extra: string[][] = []) => { const n = need(b), f = ful(s, n); return [n, f, acc(b, f, n, extra)]; };
const complaint = (a: Key, root: string, d: string, extra: string[][] = []) => sign(a, 1, [["e", root, "", "root"], ["km-complaint", "1"], ["d-store", d], ...extra], "item never arrived");
const NOW = 1_800_000_000, OLD = NOW - 400 * 86400;

describe("seed npub", () => {
  it("decodes the KlickyMart npub (bech32 checksum checked) to the site zap key in wrangler.toml", () => {
    expect((env as unknown as { KM_TRUST_SEED_NPUB: string }).KM_TRUST_SEED_NPUB).toBe(SEED_NPUB);
    const toml = Object.values((import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob("../../wrangler.toml", { query: "?raw", import: "default", eager: true }))[0]!;
    const zap = toml.match(/SITE_ZAP_PUBKEY_HEX = "([0-9a-f]{64})"/)![1];
    expect(npubToHex(SEED_NPUB)).toBe(zap);
    expect(npubToHex(SEED_NPUB.slice(0, -1) + (SEED_NPUB.endsWith("h") ? "g" : "h"))).toBeNull(); // checksum broken
    expect(npubToHex("nsec1" + SEED_NPUB.slice(5))).toBeNull(); expect(npubToHex("")).toBeNull(); expect(npubToHex(undefined)).toBeNull();
  });
});

describe("tierFor", () => {
  const ok = { firstSeenAt: OLD, registeredAt: OLD, buyers: MIN_BUYERS, complaints: 0, graphHash: "g", nowS: NOW };
  it("all conditions -> established; each missing one -> new-and-risky with a reason", () => {
    expect(tierFor(ok).tier).toBe("established");
    expect(tierFor({ ...ok, firstSeenAt: NOW - 10 * 86400 }).reasons).toEqual(["first_seen<90d"]);
    expect(tierFor({ ...ok, registeredAt: NOW - 100 * 86400 }).reasons).toEqual(["domain_age<1y"]);
    expect(tierFor({ ...ok, buyers: 4 }).reasons).toEqual(["buyers:4/5"]);
    expect(tierFor({ ...ok, complaints: 1 }).reasons).toEqual(["complaint"]);
    expect(tierFor({ ...ok, buyers: null, complaints: null }).tier).toBe("new-and-risky");
  });
});

describe("deriveBuys / deriveComplaints", () => {
  const store = key(), store2 = key();
  const keys = new Map([[store.pk, "shop.com"], [store2.pk, "shop.com"]]);
  it("counts completed threads; repeat buys from one key are separate rows but one distinct buyer", () => {
    const b = key();
    const buys = deriveBuys([...thread(b, store), ...thread(b, store)], keys);
    expect(buys).toHaveLength(2); expect(new Set(buys.map((x) => x.buyer_pubkey)).size).toBe(1);
  });
  it("store's own keys never count as buyers (same key or a second key of the same store)", () => {
    expect(deriveBuys([...thread(store, store), ...thread(store2, store)], keys)).toEqual([]);
  });
  it("unclaimed fulfiller, rejected 422, or 422 by someone else -> no buy", () => {
    const b = key(), x = key(), anon = key();
    const [n, f] = [need(b), null]; const f1 = ful(store, n);
    expect(deriveBuys(thread(b, anon), keys)).toEqual([]);
    expect(deriveBuys([n, f1, acc(b, f1, n, [["status", "rejected"]])], keys)).toEqual([]);
    expect(deriveBuys([n, f1, acc(x, f1, n)], keys)).toEqual([]);
    void f;
  });
  it("tips and amounts never matter", () => {
    const b = key();
    expect(deriveBuys(thread(b, store, [["amount", "99000000000"], ["tip", "98000000000"]]), keys)).toHaveLength(1);
  });
  it("complaints: fixed format only, matching thread domain, never from store keys", () => {
    const b = key(); const [n] = thread(b, store);
    const td = new Map([[n!.id, "shop.com"]]);
    const good = complaint(b, n!.id, "shop.com");
    const bad = [complaint(b, n!.id, "other.com"), sign(b, 1, [["e", n!.id, "", "root"], ["d-store", "shop.com"]]), complaint(store, n!.id, "shop.com"), { ...complaint(b, n!.id, "shop.com"), content: "tampered" }, complaint(b, "f".repeat(64), "shop.com")];
    expect(deriveComplaints([good, ...bad, good], td, keys).map((c) => c.event_id)).toEqual([good.id]);
  });
});

describe("graph (mocked relay)", () => {
  const seed = key(), f1 = key(), f2 = key(), outsider = key();
  const contacts = [sign(seed, 3, [["p", f1.pk]]), sign(f1, 3, [["p", f2.pk]]), sign(outsider, 3, [["p", seed.pk]])];
  const q: RelayQuery = async (flt) => contacts.filter((e) => (flt.kinds as number[]).includes(e.kind) && (flt.authors as string[]).includes(e.pubkey) && (!flt["#p"] || e.tags.some((t) => t[0] === "p" && (flt["#p"] as string[]).includes(t[1]!))));
  it("seed + 2 hops; outsiders and 3-hop keys are out; forged contact lists ignored", async () => {
    const forged = { ...sign(f1, 3, [["p", outsider.pk]]), content: "x" };
    contacts.push(forged);
    const g = await buildGraph(seed.pk, [f1.pk, f2.pk, outsider.pk], q);
    expect(g.members.get(seed.pk)).toBe(0); expect(g.members.get(f1.pk)).toBe(1); expect(g.members.get(f2.pk)).toBe(2);
    expect(g.members.has(outsider.pk)).toBe(false);
    contacts.pop();
  });
});

describe("job + read side (D1, mocked relay)", () => {
  const seedK = key(); const st = key(); const D = "shop.com";
  const buyers = Array.from({ length: 6 }, key);
  const contacts = [sign(seedK, 3, buyers.map((b) => ["p", b.pk]))];
  let notes: NostrEventLine[] = [];
  const q: RelayQuery = async (f) => (f.kinds as number[])[0] === 3 ? contacts.filter((e) => (f.authors as string[]).includes(e.pubkey)) : notes;
  const npubOf = async (hex: string) => (await import("../src/crawler-pubkey")).hexToNpub(hex);
  beforeEach(async () => {
    resetTierCache(); notes = [];
    for (const t of ["trust_buys", "trust_complaints", "trust_dismissals", "trust_graph_heads", "trust_graph_members", "store_trust_obs", "nostr_events", "store_claims"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await env.DB.prepare("INSERT INTO store_claims (domain, pubkey, method, status, event_id, claimed_at, checked_at) VALUES (?,?,?,?,?,?,?)").bind(D, st.pk, "dns", "active", "e".repeat(64), OLD, OLD).run();
    for (const [sig, v] of [["first_seen", `{"at":"${new Date(OLD * 1000).toISOString()}"}`], ["domain_registered", '{"registered":"2015-01-01"}']])
      await env.DB.prepare("INSERT INTO store_trust_obs VALUES (?,?,?,?,?,?,?,?)").bind(sig + "x", D, sig, v, "https://rdap.org/x", null, sig === "first_seen" ? "own-ledger" : "rdap", OLD).run();
  });
  const putEvents = async (evs: NostrEventLine[]) => { for (const e of evs) await env.DB.prepare("INSERT INTO nostr_events (id, kind, pubkey, created_at, d, raw_json, first_seen, relays) VALUES (?,?,?,?,?,?,?,?)").bind(e.id, e.kind, e.pubkey, e.created_at, null, JSON.stringify(e), e.created_at, "test").run(); };
  const E = async (o: Record<string, string> = {}) => ({ DB: env.DB, KM_TRUST_LABELS: "on", KM_TRUST_BUYS: "on", KM_TRUST_SEED_NPUB: await npubOf(seedK.pk), ...o });
  const tierOf = async (o: Record<string, string> = {}) => { resetTierCache(); return (await loadTiers(await E(o), NOW))!.get(D)!; };

  it("5 distinct in-graph buyers -> established; repeat buys from one key count once", async () => {
    await putEvents([...buyers.slice(0, 4).flatMap((b) => thread(b, st)), ...thread(buyers[0]!, st), ...thread(buyers[0]!, st)]);
    expect((await runTrustJob(await E(), q, NOW)).ran).toBe(true);
    expect((await tierOf()).reasons).toEqual(["buyers:4/5"]);
    await putEvents(thread(buyers[4]!, st)); await runTrustJob(await E(), q, NOW + 1);
    expect((await tierOf()).tier).toBe("established");
  });
  it("out-of-graph buyers don't count; out-of-graph complaints are ignored; in-graph complaint holds the store; only a dismissal clears it", async () => {
    const out = Array.from({ length: 5 }, key);
    const ths = [...buyers.slice(0, 5).map((b) => thread(b, st)), ...out.map((b) => thread(b, st))];
    await putEvents(ths.flat());
    const outsiderComplaint = complaint(out[0]!, ths[5]![0]!.id, D);
    notes = [outsiderComplaint]; await runTrustJob(await E(), q, NOW);
    expect((await tierOf()).tier).toBe("established"); // 5 in-graph buyers; 5 outsiders and the outsider complaint ignored
    const c = complaint(buyers[1]!, ths[1]![0]!.id, D);
    notes = [outsiderComplaint, c]; await runTrustJob(await E(), q, NOW + 1);
    expect((await tierOf()).reasons).toEqual(["complaint"]);
    await env.DB.prepare("INSERT INTO trust_dismissals (event_id, note, added_at) VALUES (?,?,?)").bind(c.id, "Matt: resolved", NOW).run();
    expect((await tierOf()).tier).toBe("established");
  });
  it("empty or invalid seed -> the job does nothing and nobody is established", async () => {
    await putEvents(buyers.slice(0, 5).flatMap((b) => thread(b, st)));
    for (const s of ["", "npub1bad"]) {
      expect((await runTrustJob(await E({ KM_TRUST_SEED_NPUB: s }), q, NOW)).ran).toBe(false);
      expect((await tierOf({ KM_TRUST_SEED_NPUB: s })).reasons).toContain("buys_unknown");
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS c FROM trust_buys").first("c")).toBe(0);
  });
  it("flags: KM_TRUST_LABELS off -> no tiers at all; KM_TRUST_BUYS off -> job no-op and buys unknown", async () => {
    expect(await loadTiers({ DB: env.DB }, NOW)).toBeNull();
    expect((await runTrustJob({ DB: env.DB, KM_TRUST_SEED_NPUB: SEED_NPUB }, q, NOW)).ran).toBe(false);
    expect((await tierOf({ KM_TRUST_BUYS: "off" })).reasons).toEqual(["buys_unknown", "complaints_unknown"]);
  });
});

describe("ranking in findOffers", () => {
  const raw = (d: string, tip: number) => JSON.stringify({ d, name: d, tips: { total_msat: tip }, tip_ready: true });
  const snap = rowsToSnapshot([
    { d: "a.com", name: "a", raw_json: raw("a.com", 0) }, { d: "b.com", name: "b", raw_json: raw("b.com", 0) }, { d: "c.com", name: "c", raw_json: raw("c.com", 0) },
  ] as never, "v", "test");
  const offer = (d: string, p: number): Offer => ({ d, n: "Pasta 1 lb", p, c: "USD", u: `https://${d}/p`, me: "jsonld", src: `https://${d}/p`, t: "2026-11-01T00:00:00Z", st: "in" });
  const offers = [offer("a.com", 3), offer("b.com", 2), offer("c.com", 1)];
  const T = (tier: "established" | "new-and-risky"): TrustField => ({ ...tierFor({ firstSeenAt: OLD, registeredAt: OLD, buyers: 5, complaints: 0, graphHash: "g", nowS: NOW }), ...(tier === "new-and-risky" ? { tier, reasons: ["buyers:0/5"] } : {}) });
  const order = (r: ReturnType<typeof findOffers>) => ((r as { body: { items: { domain: string }[] } }).body.items).map((x) => x.domain);
  it("flag off (no tiers) = today's order; no trust field", () => {
    const r = findOffers(offers, snap, "https://x", { q: "pasta" });
    expect(order(r)).toEqual(["c.com", "b.com", "a.com"]);
    expect((r as { body: { items: Record<string, unknown>[] } }).body.items[0]).not.toHaveProperty("trust");
  });
  it("tiers only lift: established moves up, nothing is hidden, every row is labeled", () => {
    const r = findOffers(offers, snap, "https://x", { q: "pasta" }, new Map([["a.com", T("established")]]));
    expect(order(r)).toEqual(["a.com", "c.com", "b.com"]);
    const items = (r as { body: { items: { trust: TrustField }[] } }).body.items;
    expect(items).toHaveLength(3); expect(items.map((i) => i.trust.tier)).toEqual(["established", "new-and-risky", "new-and-risky"]);
  });
  it("tips never change order (record tip fields vary, same result)", () => {
    const tiers = new Map([["b.com", T("established")]]);
    const base = order(findOffers(offers, snap, "https://x", { q: "pasta" }, tiers));
    const tipped = rowsToSnapshot([
      { d: "a.com", name: "a", raw_json: raw("a.com", 9e12) }, { d: "b.com", name: "b", raw_json: raw("b.com", 0) }, { d: "c.com", name: "c", raw_json: raw("c.com", 5e9) },
    ] as never, "v", "test");
    expect(order(findOffers(offers, tipped, "https://x", { q: "pasta" }, tiers))).toEqual(base);
  });
});
