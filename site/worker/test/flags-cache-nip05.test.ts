import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, buildFilters, type Ev, type IngestCtx } from "../src/relay-ingest";
import { computeFlags, readFlagCache, scanFlags, refreshFlagCache, type FNote, type FlagCtx } from "../src/flags";
import { checkNip05, robotsAllows, nip05Pass, parseNip05 } from "../src/nip05";

const D = "store.google.com";
const T0 = 1_790_000_000;
const hex = () => bytesToHex(secp.utils.randomSecretKey());
let seq = 0;
const note = (o: Partial<FNote> = {}): FNote => ({ id: (++seq).toString(16).padStart(64, "a"), d: D, pubkey: hex(), created_at: T0 + seq * 99_999, content: "", depth: "cart", price: null, currency: null, duration_s: null, steps_n: null, blocker: null, shipping: null, tax: null, tags: [], ...o });
const ctx = (ns: FNote[], o: Partial<FlagCtx> = {}): FlagCtx => ({ firstSeen: new Map(ns.map((n) => [n.pubkey, 0])), active: new Set(), tips: new Map(), reports: [], fulfillmentMsat: new Map(), ...o });
const sigs = (f: ReturnType<typeof computeFlags>, id: string) => f.get(id)?.reasons.map((r) => `${r.signal}:${r.strength}`) ?? [];

describe("NIP-05 same-operator", () => {
  it("several keys verified under one private domain: weak at 2, strong at 3; different domains: none", () => {
    const ns = [note(), note(), note()];
    const two = computeFlags(ns.slice(0, 2), ctx(ns, { nip05: new Map([[ns[0]!.pubkey, "ops.example"], [ns[1]!.pubkey, "ops.example"]]) }));
    expect(sigs(two, ns[0]!.id)).toEqual(["same-operator:weak"]);
    const three = computeFlags(ns, ctx(ns, { nip05: new Map(ns.map((n) => [n.pubkey, "ops.example"])) }));
    expect(three.get(ns[0]!.id)!.weight).toBe(0);
    const diff = computeFlags(ns.slice(0, 2), ctx(ns, { nip05: new Map([[ns[0]!.pubkey, "a.example"], [ns[1]!.pubkey, "b.example"]]) }));
    expect(diff.size).toBe(0);
  });
  it("big public providers: no flag for a few keys, weak at most", () => {
    const ns = Array.from({ length: 5 }, () => note());
    const three = computeFlags(ns.slice(0, 3), ctx(ns, { nip05: new Map(ns.map((n) => [n.pubkey, "primal.net"])) }));
    expect(three.size).toBe(0);
    const five = computeFlags(ns, ctx(ns, { nip05: new Map(ns.map((n) => [n.pubkey, "primal.net"])) }));
    expect(sigs(five, ns[0]!.id)).toEqual(["same-operator:weak"]);
    expect(five.get(ns[0]!.id)!.weight).toBe(0.5);
  });
  it("verification: robots first (404 ok, 403/disallow refused), no redirects, index refusals, name match", async () => {
    const pk = "ab".repeat(32);
    const calls: string[] = [];
    const fake = (robots: [number, string], json: [number, unknown]) => async (u: string, i?: RequestInit) => {
      calls.push(u); expect(i?.redirect).toBe("manual"); expect(String((i?.headers as Record<string, string>)["User-Agent"])).toMatch(/KlickyMartBot/);
      return u.endsWith("/robots.txt") ? new Response(robots[1], { status: robots[0] }) : new Response(JSON.stringify(json[1]), { status: json[0] });
    };
    expect((await checkNip05(pk, "bob@ops.example", fake([404, ""], [200, { names: { bob: pk } }]), () => undefined)).status).toBe("verified");
    expect(calls[0]).toBe("https://ops.example/robots.txt");
    expect((await checkNip05(pk, "bob@ops.example", fake([200, "User-agent: *\nDisallow: /.well-known/"], [200, { names: { bob: pk } }]), () => undefined)).status).toBe("robots-disallowed");
    expect((await checkNip05(pk, "bob@ops.example", fake([403, ""], [200, {}]), () => undefined)).status).toBe("robots-disallowed");
    expect((await checkNip05(pk, "bob@ops.example", fake([404, ""], [200, { names: { bob: "cd".repeat(32) } }]), () => undefined)).status).toBe("mismatch");
    expect((await checkNip05(pk, "bob@ops.example", fake([404, ""], [302, {}]), () => undefined)).status).toBe("error");
    expect((await checkNip05(pk, "bob@shop.example", fake([404, ""], [200, {}]), () => "blocked-tos")).status).toBe("gate-refused");
    expect(parseNip05("x@localhost")).toBeNull();
    expect(robotsAllows("User-agent: klickymartbot\nDisallow: /\n\nUser-agent: *\nAllow: /", "/.well-known/nostr.json")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /private", "/.well-known/nostr.json")).toBe(true);
  });
  it("profiles are fetched only for note authors", () => {
    const f = buildFilters({ domains: new Set([D]), ourPubkey: null as never }, 0, [], ["ab".repeat(32)]);
    expect(f).toContainEqual({ kinds: [0], authors: ["ab".repeat(32)] });
    expect(JSON.stringify(buildFilters({ domains: new Set([D]), ourPubkey: null as never }, 0, [], []))).not.toContain('"kinds":[0]');
  });
});

describe("price plausibility vs our crawl / offers", () => {
  it("flags a price far outside crawl prices; honest prices within range are not flagged", () => {
    const ns = [note({ price: 900 }), note({ price: 25 })];
    const f = computeFlags(ns, ctx(ns, { crawlPrices: new Map([[D, { min: 15, max: 40, n: 12 }]]) }));
    expect(sigs(f, ns[0]!.id)).toEqual(["implausible-data:weak"]);
    expect(f.has(ns[1]!.id)).toBe(false);
    const eur = note({ price: 900, currency: "EUR" });
    expect(computeFlags([eur], ctx([eur], { crawlPrices: new Map([[D, { min: 15, max: 40, n: 12 }]]) })).size).toBe(0);
  });
});

const sk = () => secp.utils.randomSecretKey();
function sign(s: Uint8Array, kind: number, tags: string[][], content = "", created_at = Math.floor(Date.now() / 1000)): Ev {
  const base = { pubkey: bytesToHex(secp.schnorr.getPublicKey(s)), created_at, kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), s)) };
}
const ictx = (): IngestCtx => ({ domains: new Set([D]), ourPubkey: null as never, flagStatic: { inStoreOnly: new Set(), crawlPrices: new Map([[D, { min: 15, max: 40, n: 3 }]]) } });
const norm = (m: Map<string, unknown>) => JSON.stringify([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));

beforeEach(async () => { for (const t of ["nostr_events", "experiences", "reviews", "tombstones", "note_flags", "nip05_checks"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("flag cache", () => {
  it("cache written on ingest equals a full scan, and stays equal after a deletion and a NIP-05 pass", async () => {
    const keys = [sk(), sk(), sk(), sk()];
    const now = Math.floor(Date.now() / 1000);
    const evs = keys.map((k, i) => sign(k, 422, [["r", D], ["depth", "cart"], ["basis", "visit"], ["price", i === 3 ? "999" : "20"], ["lud16", i < 2 ? "ops@w.test" : `k${i}@w.test`]], `note ${i}`, now - i * 5000));
    for (const ev of evs) await ingestEvents(env.DB, [{ ev, relay: "wss://r.test" }], ictx());
    const cached = await readFlagCache(env.DB);
    expect(cached.size).toBeGreaterThan(0);
    expect(norm(cached)).toBe(norm(await scanFlags(env.DB, ictx().flagStatic)));
    // author deletes one flagged note -> cache updates incrementally
    await ingestEvents(env.DB, [{ ev: sign(keys[0]!, 5, [["e", evs[0]!.id]]), relay: "wss://r.test" }], ictx());
    expect((await readFlagCache(env.DB)).has(evs[0]!.id)).toBe(false);
    expect(norm(await readFlagCache(env.DB))).toBe(norm(await scanFlags(env.DB, ictx().flagStatic)));
    // NIP-05: two remaining keys verified under one domain (local fake fetch)
    for (const k of [keys[2]!, keys[3]!]) {
      const pub = bytesToHex(secp.schnorr.getPublicKey(k));
      await ingestEvents(env.DB, [{ ev: sign(k, 0, [], JSON.stringify({ nip05: `${pub.slice(0, 8)}@ops.example` })), relay: "wss://r.test" }], ictx());
    }
    const fake = async (u: string) => u.endsWith("robots.txt") ? new Response("", { status: 404 }) : new Response(JSON.stringify({ names: Object.fromEntries([keys[2]!, keys[3]!].map((k) => { const p = bytesToHex(secp.schnorr.getPublicKey(k)); return [p.slice(0, 8), p]; })) }), { status: 200 });
    expect(await nip05Pass(env.DB, fake, () => undefined)).toBe(2);
    await refreshFlagCache(env.DB, ictx().flagStatic);
    const after = await readFlagCache(env.DB);
    expect(after.get(evs[2]!.id)!.reasons.some((r) => r.signal === "same-operator" && /NIP-05/.test(r.detail))).toBe(true);
    expect(norm(after)).toBe(norm(await scanFlags(env.DB, ictx().flagStatic)));
  });
});
