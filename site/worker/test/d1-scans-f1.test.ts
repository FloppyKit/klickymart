/** GO-KM-D1-SCANS Fix round F1: the verify failures, pinned.
 *
 * B1 GET / key, B2 /merchant key, B3 /check?domains= order: the key must separate every pair of requests that can build a
 * different body, and the cache must never answer one with the other's body. B5: the per-request memo is per request even
 * when two requests interleave. B8: a cache hit still counts the visit. B4: the GP-2 single-receiver zapper-key proof stays
 * global, like base 9db84c2.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { handleRequest, type Env } from "../src/router";
import { cacheKeyFor, setEdgeCacheEnabled } from "../src/edge-cache";
import { memoLoad, memoSize, withRequestMemoScope } from "../src/request-memo";
import { nostrEventId } from "../src/nostr-verify";
import { ingestEvents, type Ev, type IngestCtx } from "../src/relay-ingest";
import { encodeBolt11ForTest } from "../src/bolt11";
import { loadTips, summarize } from "../src/tips";
import { loadAggregates } from "../src/experience";
import { utcDay } from "../src/agent-visits";
import { measure, meteredDb, meteredEnv, type MeteredDb } from "./helpers/d1-meter";

const D = "store.google.com";
const OTHER = "books.example.net";
/** filter_ms is a timing field that already varied run to run before this GO, so it cannot be part of a body comparison. */
const stable = (body: string) => body.replace(/"filter_ms":\d+/g, '"filter_ms":0');

const m: MeteredDb = meteredDb(env.DB as D1Database);
const e = meteredEnv(env as unknown as Env, m);

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://klickymart.com${path}`, { headers: { Accept: "application/json", ...headers } });
const html = (path: string) => get(path, { Accept: "text/html" });
const key = (path: string, headers: Record<string, string> = {}) => cacheKeyFor(get(path, headers), {});

async function cached<T>(fn: () => Promise<T>): Promise<T> {
  setEdgeCacheEnabled(true);
  try { return await fn(); } finally { setEdgeCacheEnabled(null); }
}

describe("F1 B1-B3: the key separates every pair of requests with a different body", () => {
  it("B1: GET / keys on q (and every documented filter), so a search never shares the home entry", () => {
    expect(key("/?q=lamp")).not.toBe(key("/"));
    expect(key("/?q=lamp")).not.toBe(key("/?q=chair"));
    expect(key("/?limit=5")).not.toBe(key("/")); // a documented filter that changes the item list
    // normalization only: case, junk params and param order cannot mint or split an entry
    expect(key("/?q=lamp")).toBe(key("/?q=LAMP"));
    expect(key("/?q=lamp&utm_source=spam")).toBe(key("/?q=lamp"));
    expect(key("/?q=lamp&limit=20")).toBe(key("/?limit=20&q=lamp"));
  });

  it("B2: /merchant keys on the same Accept split the handler makes; /records is always JSON", () => {
    expect(key(`/merchant/${D}`, { Accept: "text/html" })).not.toBe(key(`/merchant/${D}`));
    expect(key(`/merchant/${D}`, { Accept: "text/html,application/xhtml+xml" })).toBe(key(`/merchant/${D}`, { Accept: "text/html" }));
    // the handler tests `Accept.includes("text/html")`, which is case-sensitive: mirror it exactly
    expect(key(`/merchant/${D}`, { Accept: "TEXT/HTML" })).toBe(key(`/merchant/${D}`));
    // /records/<d> answers JSON whatever the Accept header says, so its key must not depend on it
    expect(key(`/records/${D}`, { Accept: "text/html" })).toBe(key(`/records/${D}`));
  });

  it("B3: /check?domains= keeps request order in the key (the response items follow it)", () => {
    expect(key(`/check?domains=${OTHER},${D}`)).not.toBe(key(`/check?domains=${D},${OTHER}`));
    // still normalized where the handler normalizes: trim, lowercase, de-dupe (Set keeps first position)
    expect(key(`/check?domains= ${OTHER.toUpperCase()} , ${D}`)).toBe(key(`/check?domains=${OTHER},${D}`));
    expect(key(`/check?domains=${OTHER},${D},${OTHER}`)).toBe(key(`/check?domains=${OTHER},${D}`));
  });
});

describe("F1 B7: with the cache ON, no route can be answered with another route's body", () => {
  it("B1: / and /?q=lamp keep their own bodies in both directions", async () => {
    await cached(async () => {
      const home = stable(await (await handleRequest(html("/"), e)).text());
      const lamp = stable(await (await handleRequest(html("/?q=lamp"), e)).text());
      expect(lamp).not.toBe(home);
      // both again: each must be served from its own entry, not from the other one
      expect(stable(await (await handleRequest(html("/"), e)).text())).toBe(home);
      expect(stable(await (await handleRequest(html("/?q=lamp"), e)).text())).toBe(lamp);
    });
  });

  it("B2: /merchant/<d> HTML and JSON never cross", async () => {
    await cached(async () => {
      const asHtml = await (await handleRequest(get(`/merchant/${D}`, { Accept: "text/html" }), e)).text();
      const asJson = await (await handleRequest(get(`/merchant/${D}`), e)).text();
      expect(asHtml.replace(/^\s+/, "").startsWith("<!")).toBe(true);
      expect(() => JSON.parse(asJson)).not.toThrow();
      // the second pair are cache hits: each still its own representation
      expect(await (await handleRequest(get(`/merchant/${D}`, { Accept: "text/html" }), e)).text()).toBe(asHtml);
      const jsonAgain = await (await handleRequest(get(`/merchant/${D}`), e)).text();
      expect(jsonAgain).toBe(asJson);
      expect(jsonAgain.startsWith("{")).toBe(true);
    });
  });

  it("B3: /check?domains= keeps the caller's order, hit or miss", async () => {
    await cached(async () => {
      const order = async (ds: string) => (((await (await handleRequest(get(`/check?domains=${ds}`), e)).json()) as { items: { domain: string }[] }).items).map((x) => x.domain);
      expect(await order(`${OTHER},${D}`)).toEqual([OTHER, D]);
      expect(await order(`${D},${OTHER}`)).toEqual([D, OTHER]);
      // repeats are cache hits and must not hand back the other caller's order
      expect(await order(`${OTHER},${D}`)).toEqual([OTHER, D]);
      expect(await order(`${D},${OTHER}`)).toEqual([D, OTHER]);
    });
  });
});

describe("F1 B8: a cache hit still counts the visit", () => {
  it("/q: miss + hit = two visits, and the hit costs one counter upsert and no scan", async () => {
    const visits = async () => Number((await env.DB.prepare("SELECT COALESCE(SUM(n),0) AS n FROM agent_visits WHERE day = ? AND path = '/q'").bind(utcDay()).first<{ n: number }>())?.n ?? 0);
    await cached(async () => {
      const before = await visits();
      const req = () => get("/q?q=lamp");
      const first = await measure(m, () => handleRequest(req(), e)); // miss: renders and stores
      const hit = await measure(m, () => handleRequest(req(), e)); // hit: serves from the edge cache
      expect(first.queries).toBeGreaterThan(1);
      expect(hit.status).toBe(200);
      expect(hit.queries, "a hit runs exactly one statement: the visit counter").toBe(1);
      expect(hit.sqls[0]).toContain("agent_visits");
      expect(hit.rows, "that upsert reads one row at most (the conflicting counter row) and scans nothing").toBeLessThanOrEqual(1);
      expect(await visits(), "the hit is counted even though D1 was not read for the body").toBe(before + 2);
    });
  });
});

describe("F1 B5: the request memo is per request, not a module-level stack", () => {
  it("two interleaved requests never see or pop each other's memo", async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((r) => { releaseA = r; });
    let releaseB: () => void = () => {};
    const gateB = new Promise<void>((r) => { releaseB = r; });
    const loads: string[] = [];

    // A opens first, loads, then sleeps. B opens while A is still open, loads the SAME key, and also sleeps.
    const a = withRequestMemoScope(async () => {
      const own = await memoLoad("shared", async () => { loads.push("A"); return "A"; });
      await gateA;
      // A resumes while B's scope is still open: it must still read its own entry
      const again = await memoLoad("shared", async () => { loads.push("A-again"); return "A2"; });
      return `${own}/${again}/${memoSize()}`;
    });
    const b = withRequestMemoScope(async () => {
      const own = await memoLoad("shared", async () => { loads.push("B"); return "B"; });
      await gateB;
      const again = await memoLoad("shared", async () => { loads.push("B-again"); return "B2"; });
      return `${own}/${again}/${memoSize()}`;
    });
    await Promise.resolve(); // both are parked on their gates with their own scope open
    releaseA();
    expect(await a).toBe("A/A/1"); // one load, its own map, no leak from B
    releaseB();
    expect(await b).toBe("B/B/1");
    expect(loads, "each request loaded the key exactly once, in its own scope").toEqual(["A", "B"]);
    expect(memoSize(), "outside a request there is no scope").toBe(0);
  });
});

describe("F1 B4: the GP-2 single-receiver proof stays global (base 9db84c2 behaviour)", () => {
  const ctx = (): IngestCtx => ({ domains: new Set([D, OTHER]), ourPubkey: "3ac44bd91d4a0544403a0dfe4edc468c0f4e1ec8a26f2b2f58e979abe34d3242" }); // secret-scan: allow (public pubkey)
  const key = () => secp.utils.randomSecretKey();
  const pk = (sk: Uint8Array) => bytesToHex(secp.schnorr.getPublicKey(sk));
  function sign(sk: Uint8Array, kind: number, tags: string[][], content = "", created_at = Math.floor(Date.now() / 1000)): Ev {
    const base = { pubkey: pk(sk), created_at, kind, tags, content };
    const id = nostrEventId(base);
    return { ...base, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
  }
  const NODE = key();
  /** A proper NIP-57 receipt (same shape as tips-zero-r6): node-signed invoice whose description_hash commits to the 9734. */
  function zap(lnurlSk: Uint8Array, payerSk: Uint8Array, note: { id: string; pubkey: string }): Ev {
    const req = sign(payerSk, 9734, [["p", note.pubkey], ["e", note.id], ["amount", "1000000"], ["relays", "wss://r.test"]]);
    const desc = JSON.stringify(req);
    const inv = encodeBolt11ForTest(NODE, "lnbc10u", bytesToHex(sha256(new TextEncoder().encode(req.id + "x"))), { descriptionHashHex: bytesToHex(sha256(new TextEncoder().encode(desc))) });
    return sign(lnurlSk, 9735, [["p", note.pubkey], ["e", note.id], ["bolt11", inv], ["description", desc], ["P", req.pubkey]]);
  }
  const lnurlFetcher = (nostrPubkey: string) => (async () => Response.json({ allowsNostr: true, nostrPubkey, callback: "https://ln.example/cb" })) as never;
  const AGED_DAY = "2026-01-01"; // far outside the 7-day rank key-age gate
  const note = async (id: string, d: string, pubkey: string) =>
    env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,depth,content,raw_json,source,received_day,basis) VALUES (?,422,?,?,?,1,'paid','',?,'post',?,'visit')")
      .bind(id, d, pubkey, Math.floor(Date.now() / 1000), "{}", AGED_DAY).run();

  beforeEach(async () => {
    for (const t of ["nostr_events", "experiences", "reviews", "lnurl_cache", "note_flags"]) {
      try { await env.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
    }
  });

  it("a zapper key shared by two authors (one on another store) validates nothing, exactly as on base", async () => {
    const a = key(), b = key(), lnurl = key(), tipper = key();
    const n1 = sign(a, 422, [["r", D], ["depth", "paid"], ["basis", "visit"]]);
    const n2 = sign(b, 422, [["r", OTHER], ["depth", "paid"], ["basis", "visit"]]);
    await note(n1.id, D, pk(a));
    await note(n2.id, OTHER, pk(b));
    // Both authors declare the SAME lud16, so the same LNURL zapper key serves two receivers.
    const profA = sign(a, 0, [], JSON.stringify({ lud16: "shared@ln.example" }));
    const profB = sign(b, 0, [], JSON.stringify({ lud16: "shared@ln.example" }));
    await ingestEvents(env.DB, [{ ev: profA, relay: "wss://r.test" }, { ev: profB, relay: "wss://r.test" }], ctx());
    const receipt = zap(lnurl, tipper, n1);
    const res = await ingestEvents(env.DB, [{ ev: receipt, relay: "wss://r.test" }], { ...ctx(), fetcher: lnurlFetcher(pk(lnurl)) });
    expect(res.accepted).toBe(1);

    // base 9db84c2: loadAggregates read tips for the WHOLE index, so the key's two declaring authors are both in scope and
    // the proof fails closed -> the tip shows, but it validates (and bonuses) nothing.
    const global = summarize((await loadTips(env.DB)).byNote.get(n1.id) ?? []);
    expect(global).toMatchObject({ tips: 1, validated_tippers: 0, bonus_tippers: 0 });
    const agg = (await loadAggregates(env.DB, [D])).get(D);
    expect(agg, "the seeded note really does produce the /check aggregate").toBeDefined();
    expect(agg!.tips, "the /check aggregate must equal the global proof, not a store-scoped one").toMatchObject({
      tips: 1, validated_tippers: 0, bonus_tippers: 0,
    });
    // and the test is not vacuous: a store-scoped scope is exactly what would have flipped it
    const scoped = summarize((await loadTips(env.DB, D)).byNote.get(n1.id) ?? []);
    expect(scoped.validated_tippers).toBe(1);
  });
});
