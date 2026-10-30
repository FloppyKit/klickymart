import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, type Ev } from "../src/relay-ingest";
import { computeFlags, type FNote, type FlagCtx } from "../src/flags";
import type { Tip } from "../src/tips";
import { WALLET_GUIDE } from "../src/wallet";

const D = "store.google.com";
const T0 = 1_790_000_000;
const k = () => bytesToHex(secp.utils.randomSecretKey());
let seq = 0;
const note = (o: Partial<FNote> = {}): FNote => ({ id: (++seq).toString(16).padStart(64, "0"), d: D, pubkey: k(), created_at: T0, content: "", depth: "cart", price: null, currency: null, duration_s: null, steps_n: null, blocker: null, shipping: null, tax: null, tags: [], ...o });
const ctx = (o: Partial<FlagCtx> = {}): FlagCtx => ({ firstSeen: new Map(), active: new Set(), tips: new Map(), reports: [], fulfillmentMsat: new Map(), ...o });
const old = (ns: FNote[]) => new Map(ns.map((n) => [n.pubkey, n.created_at - 90 * 86400]));
const sig = (f: ReturnType<typeof computeFlags>, id: string) => f.get(id)?.reasons.map((r) => r.signal) ?? [];
const tip = (tipper: string, target: string, validated = true): Tip => ({ receipt: k(), target, tipper, sats: 100, validated, self: false, created_at: T0 });

describe("anti-gaming flags (explainable, never hide)", () => {
  it("false-positive control: two honest independent agents are not flagged", () => {
    const a = note({ content: "Guest checkout worked, shipping shown before payment, paid with lightning in four steps.", price: 20, duration_s: 300, steps_n: 4 });
    const b = note({ created_at: T0 + 5000, content: "Needed an account at the cart step, gave up. Prices looked normal for the category.", price: 22, duration_s: 120, steps_n: 2 });
    expect(computeFlags([a, b], ctx()).size).toBe(0); // both brand-new keys, still fine
  });
  it("burst of brand-new keys on one store: weak at 3, strong at 6", () => {
    const ns = Array.from({ length: 3 }, (_, i) => note({ created_at: T0 + i * 1000 }));
    const f = computeFlags(ns, ctx());
    expect(sig(f, ns[0]!.id)).toContain("new-key-burst");
    expect(f.get(ns[0]!.id)!.weight).toBe(0.5);
    const six = Array.from({ length: 6 }, (_, i) => note({ created_at: T0 + i * 777 }));
    expect(computeFlags(six, ctx({ firstSeen: new Map() })).get(six[0]!.id)!.weight).toBe(0);
    expect(computeFlags(ns, ctx({ firstSeen: old(ns) })).size).toBe(0); // established keys: no burst
  });
  it("evenly spaced timing across keys", () => {
    const ns = Array.from({ length: 4 }, (_, i) => note({ created_at: T0 + i * 3600 }));
    expect(sig(computeFlags(ns, ctx({ firstSeen: old(ns) })), ns[1]!.id)).toContain("timing-cluster");
    const irregular = [0, 1000, 5000, 5100].map((t) => note({ created_at: T0 + t }));
    expect(computeFlags(irregular, ctx({ firstSeen: old(irregular) })).size).toBe(0);
  });
  it("near-duplicate text and identical field values across keys", () => {
    const txt = "Great store, fast guest checkout, lightning accepted, would buy again for sure friends";
    const ns = [note({ content: txt }), note({ created_at: T0 + 99999, content: txt.replace("friends", "folks") })];
    expect(sig(computeFlags(ns, ctx({ firstSeen: old(ns) })), ns[0]!.id)).toContain("near-duplicate");
    const fp = Array.from({ length: 3 }, (_, i) => note({ created_at: T0 + i * 50000 + i * i * 999, price: 10, duration_s: 61, steps_n: 3 }));
    expect(sig(computeFlags(fp, ctx({ firstSeen: old(fp) })), fp[0]!.id)).toContain("near-duplicate");
  });
  it("tip rings and tip-only tippers: flagged and their tips stop adding weight", () => {
    const a = note(), b = note({ created_at: T0 + 99999 });
    const tips = new Map([[a.id, [tip(b.pubkey, a.id)]], [b.id, [tip(a.pubkey, b.id)]]]);
    const f = computeFlags([a, b], ctx({ firstSeen: old([a, b]), active: new Set([a.pubkey, b.pubkey]), tips }));
    expect(sig(f, a.id)).toContain("tip-ring");
    expect(f.get(a.id)!.tip_weight).toBe(1);
    const c = note();
    const f2 = computeFlags([c], ctx({ firstSeen: old([c]), active: new Set([c.pubkey]), tips: new Map([[c.id, [tip(k(), c.id), tip(k(), c.id)]]]) }));
    expect(sig(f2, c.id)).toContain("tip-only-tippers");
    // honest tips from active keys: no flag, full tip weight
    const t1 = k(), t2 = k();
    const f3 = computeFlags([c], ctx({ firstSeen: old([c]), active: new Set([c.pubkey, t1, t2]), tips: new Map([[c.id, [tip(t1, c.id), tip(t2, c.id)]]]) }));
    expect(f3.size).toBe(0);
  });
  it("implausible data: price far off, in-store-only depth, proof amount mismatch", () => {
    const ns = [note({ price: 20 }), note({ created_at: T0 + 99999, price: 22 }), note({ created_at: T0 + 199999, price: 500 })];
    const f = computeFlags(ns, ctx({ firstSeen: old(ns) }));
    expect(sig(f, ns[2]!.id)).toContain("implausible-data");
    expect(f.has(ns[0]!.id)).toBe(false);
    const paid = note({ depth: "paid" });
    expect(sig(computeFlags([paid], ctx({ firstSeen: old([paid]), inStoreOnly: new Set([D]) })), paid.id)).toContain("implausible-data");
    const ful = "f".repeat(64);
    const m = note({ tags: [["e", ful, "", "fulfillment"], ["amount", "5000000"]] });
    const fm = computeFlags([m], ctx({ firstSeen: old([m]), fulfillmentMsat: new Map([[ful, 1_000_000]]) }));
    expect(fm.get(m.id)).toMatchObject({ level: "strong", weight: 0 });
  });
  it("same-operator hint: shared lud16 across keys", () => {
    const ns = [note({ tags: [["lud16", "ops@wallet.test"]] }), note({ created_at: T0 + 99999, tags: [["lud16", "OPS@wallet.test"]] })];
    expect(sig(computeFlags(ns, ctx({ firstSeen: old(ns) })), ns[1]!.id)).toContain("same-operator");
    const distinct = [note({ tags: [["lud16", "a@w.test"]] }), note({ created_at: T0 + 99999, tags: [["lud16", "b@w.test"]] })];
    expect(computeFlags(distinct, ctx({ firstSeen: old(distinct) })).size).toBe(0);
  });
  it("community reports: distinct established reporters needed; burst / brand-new reporters and the author don't count", () => {
    const n = note();
    const rep = (pk: string, t = T0 + 100) => ({ id: k(), pubkey: pk, created_at: t, target: n.id, reason: "spam" });
    const r1 = k(), r2 = k();
    const fs = new Map([[n.pubkey, T0 - 9e6], [r1, T0 - 9e6], [r2, T0 - 9e6]]);
    expect(computeFlags([n], ctx({ firstSeen: fs, reports: [rep(r1), rep(r1)] })).size).toBe(0); // one key twice
    expect(sig(computeFlags([n], ctx({ firstSeen: fs, reports: [rep(r1), rep(r2)] })), n.id)).toContain("community-reports");
    const sybils = [k(), k(), k(), k()].map((p) => rep(p)); // brand-new, no other activity, same hour
    expect(computeFlags([n], ctx({ firstSeen: fs, reports: sybils })).size).toBe(0);
    expect(computeFlags([n], ctx({ firstSeen: fs, reports: [rep(n.pubkey), rep(r1)] })).size).toBe(0);
  });
});

const sk = () => secp.utils.randomSecretKey();
function sign(s: Uint8Array, kind: number, tags: string[][], content = ""): Ev {
  const base = { pubkey: bytesToHex(secp.schnorr.getPublicKey(s)), created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = nostrEventId(base);
  return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), s)) };
}
beforeEach(async () => { for (const t of ["nostr_events", "experiences", "reviews", "tombstones"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("routes", () => {
  it("POST /flag stores a signed 1984 (not published), /flags.json lists flagged notes with reasons; note stays visible", async () => {
    const n = sign(sk(), 422, [["r", D], ["depth", "cart"], ["basis", "visit"]], "x");
    await ingestEvents(env.DB, [{ ev: n, relay: "wss://r.test" }], { domains: new Set([D]), ourPubkey: null as never });
    const reporters = [sk(), sk()];
    for (const r of reporters) {
      await env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,content,raw_json,source,received_day,basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(k(), 422, "other.example", bytesToHex(secp.schnorr.getPublicKey(r)), 1, 0, "", "{}", "post", "2026-01-01", "visit").run().catch(() => {});
      const res = await SELF.fetch("https://example.com/flag", { method: "POST", body: JSON.stringify(sign(r, 1984, [["e", n.id, "spam"]])) });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { published: boolean }).published).toBe(false);
    }
    const bad = await SELF.fetch("https://example.com/flag", { method: "POST", body: JSON.stringify(sign(sk(), 1984, [["e", "ab".repeat(32), "spam"]])) });
    expect(bad.status).toBe(400);
    const fj = await (await SELF.fetch(`https://example.com/flags.json?domain=${D}`)).json() as { flagged_notes: number; items: { id: string; label: string }[]; appeal: string };
    expect(fj.items.find((x) => x.id === n.id)?.label).toMatch(/reported by 2 independent keys/);
    expect(fj.appeal).toMatch(/reply|delete/);
    const ex = await env.DB.prepare("SELECT COUNT(*) AS c FROM experiences WHERE id = ?").bind(n.id).first<{ c: number }>();
    expect(ex!.c).toBe(1);
  });
  it("/wallet page and wallet_setup_guide: non-custodial, FKT placeholder, checklist, no affiliate params", async () => {
    const html = await (await SELF.fetch("https://example.com/wallet")).text();
    expect(html).toContain("FKT wallet onboarding: coming later");
    expect(html).toContain("/report#km-sign");
    expect(html).toMatch(/mint holds the bitcoin/i);
    expect(html).not.toMatch(/[?&](ref|aff|affiliate|utm_[a-z]+)=/i);
    const r = await SELF.fetch("https://example.com/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wallet_setup_guide", arguments: {} } }) });
    const body = JSON.stringify(await r.json());
    expect(body).toContain("checklist");
    expect(WALLET_GUIDE.checklist.length).toBeGreaterThan(4);
    expect(JSON.stringify(WALLET_GUIDE)).not.toContain("bitcoinmints.com");
  });
});
