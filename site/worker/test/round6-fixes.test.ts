/** GO-KM-TIPS-ZERO-R6 Part B: round-6 bugs.
 *  B4/B5 guest=1 semantics + guest=confirmed + guest/co on /q items, B6 the 7-day created_at window on POST /reviews,
 *  B7 dry runs use no real limit and have their own 20/hour budget, B8 openapi documents POST /reviews,
 *  B9 category-only /alternatives resolves product words to a sub, B10 MCP carries the one_time_link_card note. */
import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { NOSTR_KIND_ACCEPTANCE } from "../src/nostr-kinds";
import { querySnapshot, validateQueryParams } from "../src/query";
import { rowsToSnapshot } from "../src/index-mem";
import { ingestFromNdjsonText } from "../src/ingest";
import { findAlternatives } from "../src/alternatives";
import REAL from "../../../data/records.ndjson?raw";

const D = "store.google.com";
const A = "31420:" + "a".repeat(64) + ":" + D;
const now = () => Math.floor(Date.now() / 1000);
function sign(tags: string[][], content = "Reached checkout, card only.", sk = secp.utils.randomSecretKey(), kind = NOSTR_KIND_ACCEPTANCE, created_at = now()) {
  const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk));
  const ev = { pubkey, created_at, kind, tags, content };
  const id = nostrEventId(ev);
  const sig = bytesToHex(secp.schnorr.sign(hexToBytes(id), sk));
  return { ...ev, id, sig };
}
const reviewTags = (extra: string[][] = []) => [["a", A], ["r", D], ["rating", "4", "5"], ["attempt", "checkout"], ...extra];
const expTags = (extra: string[][] = []) => [["r", D], ["basis", "visit"], ["depth", "checkout"], ...extra];
const post = (ev: unknown, q = "") => SELF.fetch(`https://example.com/reviews${q}`, { method: "POST", body: JSON.stringify(ev), headers: { "Content-Type": "application/json" } });
const mcp = async (name: string, args: Record<string, unknown>) => (await (await SELF.fetch("https://example.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as { result?: { content: { text: string }[]; structuredContent: Record<string, unknown> }; error?: { message: string } };
const getJson = async <T>(p: string) => (await (await SELF.fetch(`https://example.com${p}`)).json()) as T;
let realSnapCache: ReturnType<typeof rowsToSnapshot> | null = null;
async function realSnap() {
  if (!realSnapCache) { const { rows, report } = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, sourceLabel: "test-real" }); realSnapCache = rowsToSnapshot([...rows.values()], report.version, report.source); }
  return realSnapCache;
}

describe("GO-KM-TIPS-ZERO-R6 B4/B5: guest=1 keeps unknown, guest=confirmed is strict, items carry guest + co", () => {
  type Q = { total: number; items: { d: string; guest: boolean | null; co: number | null }[]; guest_filter?: { strict: boolean; note: string } };
  it("guest=1 drops only stores KNOWN to require an account and keeps guest null, ranked after guest true (real records)", async () => {
    const snap = await realSnap();
    const q = (s: string) => { const v = validateQueryParams(new URLSearchParams(s)); if (!v.ok) throw new Error(v.message); return querySnapshot(snap, v.params); };
    const all = q("reachable=1&limit=500");
    const g1 = q("reachable=1&guest=1&limit=500");
    const confirmed = q("reachable=1&guest=confirmed&limit=500");
    expect(all.total).toBeGreaterThan(0);
    expect(g1.total).toBeLessThan(all.total); // the account-required store(s) are dropped
    expect(g1.total).toBeGreaterThan(all.total - 5); // but nothing else is: llms.txt line 56 semantics
    // querySnapshot returns IndexRows, so guest is 1 | 0 | null here
    expect(g1.items.every((i) => (i.guest as unknown) !== 0)).toBe(true);
    expect(g1.items.some((i) => (i.guest as unknown) === null)).toBe(true); // unknown kept (the round-6 bug dropped it)
    expect(g1.items.some((i) => (i.guest as unknown) === 1)).toBe(true);
    // guest true first, null after
    expect(total_order_ok(g1.items as unknown as { guest: boolean | null }[])).toBe(true);
    // strict form: guest=true only
    expect(confirmed.items.every((i) => (i.guest as unknown) === 1)).toBe(true);
    expect(confirmed.total).toBeLessThan(g1.total);
    expect(confirmed.total).toBe(g1.items.filter((i) => (i.guest as unknown) === 1).length);
  });
  it("HTTP /q items carry guest (true|false|null) and co, the same values /check reports", async () => {
    const q = await getJson<Q & { guest_filter?: { strict: boolean } }>("/q?reachable=1&limit=5&guest=1");
    expect(q.items.length).toBeGreaterThan(0);
    for (const i of q.items) {
      expect(["boolean", "object"]).toContain(typeof i.guest); // null is typeof "object"
      expect(i).toHaveProperty("co");
      const chk = await getJson<{ checkout_depth: { co: number | null; guest: boolean | null } }>(`/check?domain=${i.d}`);
      expect(chk.checkout_depth.co).toBe(i.co);
      expect(chk.checkout_depth.guest).toBe(i.guest);
    }
    expect(q.guest_filter?.strict).toBe(false);
    const strict = await getJson<Q>("/q?reachable=1&guest=confirmed");
    expect(strict.guest_filter?.strict).toBe(true);
    expect((await SELF.fetch("https://example.com/q?guest=maybe")).status).toBe(400);
  });
  it("MCP search_merchants guest:true is the same result as the JSON endpoint", async () => {
    const http = await getJson<Q>("/q?pay=ln&reachable=1&guest=1&limit=100");
    const m = await mcp("search_merchants", { pay: "ln", reachable: true, guest: true, limit: 100 });
    if (m.error) throw new Error(m.error.message);
    const sc = m.result!.structuredContent as unknown as Q;
    expect(sc.total).toBe(http.total);
    expect(sc.items.map((i) => i.d)).toEqual(http.items.map((i) => i.d));
    expect(sc.items.every((i) => i.guest !== false)).toBe(true);
    const strict = await mcp("search_merchants", { reachable: true, guest: "confirmed", limit: 100 });
    expect((strict.result!.structuredContent as unknown as Q).items.every((i) => i.guest === true)).toBe(true);
  });
  it("/alternatives guest=confirmed is the strict form of guest=1", async () => {
    const snap = await realSnap();
    const loose = findAlternatives(snap, "https://klickymart.com", { category: "electronics", guest: true, limit: 50 });
    const strict = findAlternatives(snap, "https://klickymart.com", { category: "electronics", guest: true, guest_strict: true, limit: 50 });
    if (!loose.ok || !strict.ok) throw new Error("bad input");
    const l = loose.body as unknown as { items: { d: string; guest: boolean | null }[]; filters: { guest_strict?: boolean } };
    const s = strict.body as unknown as { items: { d: string; guest: boolean | null }[]; filters: { guest_strict?: boolean } };
    expect(l.items.every((i) => i.guest !== false)).toBe(true);
    expect(l.items.some((i) => i.guest === null)).toBe(true);
    expect(s.items.every((i) => i.guest === true)).toBe(true);
    expect(s.filters.guest_strict).toBe(true);
    expect(s.items.length).toBe(l.items.filter((i) => i.guest === true).length);
  });
});
/** guest true items all come before guest null ones. */
function total_order_ok(items: { guest: boolean | null }[]) {
  let sawUnknown = false;
  for (const i of items) { if (i.guest === null) sawUnknown = true; else if (i.guest === true && sawUnknown) return false; }
  return true;
}

describe("GO-KM-TIPS-ZERO-R6 B6: POST /reviews enforces the documented 7-day created_at window", () => {
  it("7d-1s is accepted, 7d+1s is rejected with bad_time (review and shopping-experience shapes)", async () => {
    const justIn = await post(sign(reviewTags([["pay", "card"]]), "inside the window", undefined, NOSTR_KIND_ACCEPTANCE, now() - (7 * 86400 - 1)));
    expect(justIn.status).toBe(201);
    const old = await post(sign(reviewTags([["pay", "card"]]), "too old", undefined, NOSTR_KIND_ACCEPTANCE, now() - (7 * 86400 + 1)));
    expect(old.status).toBe(400);
    expect((await old.json<{ error: { code: string } }>()).error.code).toBe("bad_time");
    // Sherlock: an experience note 8.00004 days old used to get ok=true through the 30-day experience window.
    const sherlock = await post(sign(expTags([["rating", "3", "5"]]), "eight days old", undefined, NOSTR_KIND_ACCEPTANCE, now() - Math.round(8.00004 * 86400)));
    expect(sherlock.status).toBe(400);
    const body = await sherlock.json<{ ok: boolean; error: { code: string; message: string } }>();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("bad_time");
    expect(body.error.message).toMatch(/7 days/);
    // and the dry run says the same
    const dry = await post(sign(expTags(), "eight days old, dry", undefined, NOSTR_KIND_ACCEPTANCE, now() - 8 * 86400), "?dry_run=1");
    expect(dry.status).toBe(400);
  });
});

describe("GO-KM-TIPS-ZERO-R6 B7: dry runs use no real limit and have their own hourly budget", () => {
  it("a dry run never spends the 1-per-key-per-merchant or 5-per-key-per-day limits", async () => {
    const sk = secp.utils.randomSecretKey();
    for (let i = 0; i < 3; i++) {
      const r = await post(sign(reviewTags([["pay", "card"]]), `dry ${i}`, sk), "?dry_run=1");
      expect(r.status).toBe(200);
      const b = await r.json<{ dry_run: boolean; stored: boolean; limits_would_apply: Record<string, unknown> }>();
      expect(b.dry_run).toBe(true);
      expect(b.stored).toBe(false);
      const lim = b.limits_would_apply as { per_key_per_merchant_per_day: { limit: number; used: number; would_hit: boolean }; per_key_per_day: { limit: number; used: number }; dry_run: boolean };
      expect(lim.per_key_per_merchant_per_day.limit).toBe(1);
      expect(lim.per_key_per_merchant_per_day.used).toBe(0); // nothing was taken by the earlier dry runs
      expect(lim.per_key_per_merchant_per_day.would_hit).toBe(false);
      expect(lim.per_key_per_day.limit).toBe(5);
    }
    const real = await post(sign(reviewTags([["pay", "card"]]), "real", sk));
    expect(real.status).toBe(201); // the real submit still had its slot after three dry runs
    const again = await post(sign(reviewTags([["pay", "card"]]), "second real", sk));
    expect(again.status).toBe(429);
    const after = await post(sign(reviewTags([["pay", "card"]]), "dry after", sk), "?dry_run=1");
    expect(after.status).toBe(200); // dry runs keep working after a real one
    const b = await after.json<{ limits_would_apply: { per_key_per_merchant_per_day: { used: number; would_hit: boolean }; any_limit_would_hit: string[] } }>();
    expect(b.limits_would_apply.per_key_per_merchant_per_day.used).toBe(1);
    expect(b.limits_would_apply.per_key_per_merchant_per_day.would_hit).toBe(true);
    expect(b.limits_would_apply.any_limit_would_hit).toContain("per_key_per_merchant_per_day");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM reviews WHERE pubkey = ?").bind(bytesToHex(secp.schnorr.getPublicKey(sk))).first<{ n: number }>();
    expect(n?.n).toBe(1); // only the real one was stored
  });
  it("dry runs have their own 20-per-hour-per-key limit (and say so)", async () => {
    const sk = secp.utils.randomSecretKey();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await post(sign(reviewTags([["pay", "card"]]), `burst ${i}`, sk), "?dry_run=1")).status);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
    const last = await post(sign(reviewTags([["pay", "card"]]), "over budget", sk), "?dry_run=1");
    const b = await last.json<{ dry_run: boolean; error: { code: string; message: string } }>();
    expect(b.dry_run).toBe(true);
    expect(b.error.code).toBe("rate_limited");
    expect(b.error.message).toMatch(/20 per hour/);
    // the key's real submit is untouched by the dry-run budget
    expect((await post(sign(reviewTags([["pay", "card"]]), "real after burst", sk))).status).toBe(201);
  });
});

describe("GO-KM-TIPS-ZERO-R6 B8: openapi documents POST /reviews", () => {
  it("the path, the dry_run param, the body and the response fields are described", async () => {
    const o = await getJson<{ paths: Record<string, { post?: { parameters?: { name: string }[]; requestBody?: unknown; responses: Record<string, { description: string }> } }> }>("/openapi.json");
    const p = o.paths["/reviews"]?.post;
    expect(p).toBeDefined();
    expect((p!.parameters ?? []).map((x) => x.name)).toContain("dry_run");
    expect(JSON.stringify(p!.requestBody)).toContain("created_at");
    expect(Object.keys(p!.responses)).toEqual(expect.arrayContaining(["200", "201", "400", "429"]));
    const d = JSON.stringify(p!.responses);
    for (const f of ["ok", "stored", "counts_toward_chart", "counts_after", "dry_run", "limits_would_apply"]) expect(d).toContain(f);
    // the tools/paths cross-check still holds: the same path list feeds /.well-known
    const wk = await getJson<{ endpoints: { paths?: string[] } | string[] }>("/.well-known/klickymart.json");
    expect(JSON.stringify(wk)).toContain("/reviews");
  });
});

describe("GO-KM-TIPS-ZERO-R6 B9: /alternatives category-only resolves a product word to the same sub", () => {
  it("headphones with no domain resolves to sub audio / electronics and returns the same stores as the domain form", async () => {
    const snap = await realSnap();
    const only = findAlternatives(snap, "https://klickymart.com", { category: "headphones", limit: 50 });
    const withDomain = findAlternatives(snap, "https://klickymart.com", { domain: "amazon.com", category: "headphones", limit: 50 });
    if (!only.ok || !withDomain.ok) throw new Error("bad input");
    const o = only.body as unknown as { count: number; total: number; sub: string | null; categories: string[]; items: { d: string; sub_match: string | null }[] };
    const w = withDomain.body as unknown as { count: number; total: number; sub: string | null; categories: string[]; items: { d: string }[] };
    expect(o.sub).toBe("audio");
    expect(o.categories).toEqual(["electronics"]);
    expect(o.count).toBeGreaterThan(0);
    expect(w.sub).toBe("audio");
    // the category-only form is the domain form without the domain itself
    expect(o.items.map((i) => i.d)).toEqual(expect.arrayContaining(w.items.map((i) => i.d)));
    expect(o.items.some((i) => i.d === "amazon.com")).toBe(true);
    expect(o.total).toBe(w.total + 1);
    // and over HTTP, with no domain at all
    const http = await getJson<{ count: number; sub: string | null; categories: string[] }>("/alternatives?category=headphones");
    expect(http.sub).toBe("audio");
    expect(http.categories).toEqual(["electronics"]);
    expect(http.count).toBeGreaterThan(0);
    const httpDomain = await getJson<{ count: number }>("/alternatives?domain=amazon.com&category=headphones");
    expect(httpDomain.count).toBeGreaterThan(0);
  });
});

describe("GO-KM-TIPS-ZERO-R6 B10: MCP carries the one_time_link_card note when pay=link finds nothing", () => {
  it("search_merchants pay=link: 0 results + the same note as the JSON /q empty_note", async () => {
    const http = await getJson<{ total: number; empty_note?: { one_time_link_card: string } }>("/q?pay=link&reachable=1");
    expect(http.total).toBe(0);
    expect(http.empty_note?.one_time_link_card).toBeDefined();
    const m = await mcp("search_merchants", { pay: ["link"], reachable: true, limit: 3 });
    if (m.error) throw new Error(m.error.message);
    expect(m.result!.content[0]!.text).toContain("one-time card");
    expect((m.result!.structuredContent as { empty_note?: { one_time_link_card: string } }).empty_note?.one_time_link_card).toBe(http.empty_note!.one_time_link_card);
  });
  it("find_offers pay=link: no store observed taking Link, so the note explains the one-time card", async () => {
    const m = await mcp("find_offers", { q: "headphones", pay: "link" });
    if (m.error) throw new Error(m.error.message);
    const sc = m.result!.structuredContent as { count: number; items: unknown[]; empty_note?: { one_time_link_card: string } };
    expect(sc.count).toBe(0);
    expect(sc.empty_note?.one_time_link_card).toMatch(/one-time card/);
    expect(m.result!.content[0]!.text).toContain("one-time card");
    // without pay= the same query does return offers, so the note is about the filter, not about an empty catalog
    const alla = await mcp("find_offers", { q: "headphones" });
    expect((alla.result!.structuredContent as { count: number }).count).toBeGreaterThan(0);
    // and a pay code those stores were never observed taking keeps nothing either (unknown, never assumed): say so
    const card = await mcp("find_offers", { q: "headphones", pay: "card" });
    const sc2 = card.result!.structuredContent as { count: number; empty_note?: unknown; pay_filter?: { note: string } };
    expect(sc2.count).toBe(0);
    expect(sc2.empty_note).toBeUndefined(); // only Link gets the one-time-card note
    expect(sc2.pay_filter?.note).toMatch(/not observed|left out/);
  });
});
