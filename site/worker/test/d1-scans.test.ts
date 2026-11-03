import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleRequest, type Env } from "../src/router";
import { cacheKeyFor, forgetEdgeCache, planEdgeCache, setEdgeCacheEnabled } from "../src/edge-cache";
import { visibleSql } from "../src/takedown";
import { measure, meteredDb, meteredEnv, type MeteredDb } from "./helpers/d1-meter";

/** GO-KM-D1-SCANS: what the heavy public reads cost in D1 rows, before the edge cache and after it.
 *
 * The numbers are `meta.rows_read` from D1 on the e2e fixture DB, i.e. the rows Cloudflare bills for. "BEFORE" is the
 * same handler with the cache turned off (today's behaviour); "AFTER first" is the first request for a key (cache miss,
 * still does the work); "AFTER repeat" is the second one inside the TTL, which must read 0 rows.
 *
 * A small, realistic amount of community data is seeded first: with an empty experiences/reviews/note_flags table every
 * query scans 0 rows and the table would say nothing about the real cost. */
const D = "store.google.com";
const OTHER = "books.example.net";
/** filter_ms is a timing field that already varied run to run before this GO, so it cannot be part of a byte comparison. */
const stable = (body: string) => body.replace(/"filter_ms":\d+/g, '"filter_ms":0');

const m: MeteredDb = meteredDb(env.DB as D1Database);
const e = meteredEnv(env as unknown as Env, m);
const hex = (n: number) => n.toString(16).padStart(64, "0");

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://klickymart.com${path}`, { headers: { Accept: "application/json", ...headers } });
const html = (path: string) => get(path, { Accept: "text/html" });
/** The plan the router itself would use (the body matters for POST /mcp). */
const planOf = async (req: Request) =>
  planEdgeCache(req, e as unknown as { KM_EDGE_CACHE?: string }, req.method === "POST" ? await req.clone().text() : undefined);

const mcp = (name: string, args: Record<string, unknown>) =>
  new Request("https://klickymart.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

/** Every route GO §1 names. /community has no standalone route: it is the community block of /check, /records and the
 * get_reviews tool, so /records stands in for it here. */
const ROUTES: { label: string; req: () => Request }[] = [
  { label: "GET /", req: () => html("/") },
  { label: "GET /chart", req: () => html("/chart") },
  { label: "GET /chart.json", req: () => get("/chart.json") },
  { label: "GET /q?q=lamp", req: () => get("/q?q=lamp") },
  { label: "GET /check", req: () => get(`/check?domain=${D}`) },
  { label: "GET /alternatives", req: () => get(`/alternatives?domain=${D}`) },
  { label: "GET /offers", req: () => get("/offers?q=lamp") },
  { label: "GET /records (community block)", req: () => get(`/records/${D}`) },
  { label: "GET /tips.json", req: () => get(`/tips.json?domain=${D}`) },
  { label: "GET /flags.json", req: () => get("/flags.json") },
  { label: "GET /flags.json?domain", req: () => get(`/flags.json?domain=${D}`) },
  { label: "MCP search_merchants", req: () => mcp("search_merchants", { q: "lamp" }) },
  { label: "MCP find_offers", req: () => mcp("find_offers", { q: "lamp" }) },
  { label: "MCP get_record", req: () => mcp("get_record", { domain: D }) },
];

/** Community data so the full-table scans in loadAggregates / readFlagCache / loadTips actually read something. */
async function seed(): Promise<void> {
  const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86400_000).toISOString().slice(0, 10);
  const old = Math.floor(Date.now() / 1000) - 40 * 86400;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < 60; i++) {
    const d = i % 3 === 0 ? D : i % 3 === 1 ? OTHER : `store${i}.example.org`;
    const pk = hex(0x5000 + (i % 25)); // a handful of keys, all old enough to count toward the chart
    const id = hex(0x900000 + i);
    stmts.push(env.DB.prepare(
      "INSERT OR IGNORE INTO experiences (id,kind,d,pubkey,created_at,structured,depth,guest,account_required,pay_used,pay_offered,btc_route,tax_before,ship_before,price,shipping,tax,total,currency,region,steps_n,duration_s,blocker,walls,agent,delivered,delivery_days,rating5,product,proof,proof_status,content,raw_json,source,relays,received_day,basis) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(id, 422, d, pk, old + i, 1, i % 2 ? "cart" : "payment", "yes", "no", "card", '["card"]', null, "yes", "yes",
      20 + i, 5, 1.6, 26.6 + i, "USD", "660", 4, 300, null, "[]", "agent/1.0", "yes", 3, 4, null, null, null,
      `seeded note ${i} about ${d}`, "{}", "post", null, day(-40), "visit"));
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO note_flags (id,d,pubkey,level,weight,tip_weight,reasons_json,computed_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(id, d, pk, "weak", 0.5, null, "[]", old + i));
    // key age: the rank gate reads ingest time, so the keys must look 40 days old
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)")
      .bind(hex(0xa00000 + i), 422, pk, old + i, d, JSON.stringify({ id, kind: 422, pubkey: pk, created_at: old + i, tags: [], content: `seeded note ${i}`, sig: "" }), old - 100, "t"));
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO reviews (id,d,pubkey,created_at,rating,rating_max,attempt,pay,fulfillment,proof,content,raw_json,received_day) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(hex(0xb00000 + i), d, pk, old + i, 4, 5, "checkout", "card", null, null, `seeded review ${i}`, "{}", day(-40)));
  }
  await env.DB.batch(stmts);
}

interface Row { label: string; before: { rows: number; queries: number }; first: { rows: number; queries: number }; repeat: { rows: number; queries: number }; sameBody: boolean }

describe("GO-KM-D1-SCANS rows-read harness (fixture DB)", () => {
  it("BEFORE (cache off) vs AFTER (edge cache): repeat hits read 0 D1 rows, bodies unchanged", async () => {
    await seed();
    const rows: Row[] = [];
    for (const r of ROUTES) {
      // wrangler.toml keeps the cache off for local dev/e2e; the harness turns it on explicitly.
      setEdgeCacheEnabled(true);
      // warm the per-isolate snapshot/tier caches: the number we care about is the steady-state cost of one more request
      await (await handleRequest(r.req(), e)).text();
      const plan = await planOf(r.req());
      expect(plan, r.label).not.toBeNull();

      setEdgeCacheEnabled(false);
      const before = await measure(m, () => handleRequest(r.req(), e));
      const before2 = await measure(m, () => handleRequest(r.req(), e));
      expect(before2.rows, `${r.label}: without the cache every request pays`).toBe(before.rows);

      setEdgeCacheEnabled(true);
      await forgetEdgeCache(plan!.key);
      const first = await measure(m, () => handleRequest(r.req(), e)); // genuine miss
      const repeat = await measure(m, () => handleRequest(r.req(), e)); // hit
      expect(repeat.rows, `${r.label}: a repeat hit must read 0 D1 rows`).toBe(0);
      expect(repeat.queries, `${r.label}: a repeat hit must run 0 queries`).toBe(0);
      expect(stable(repeat.body), `${r.label}: the body must be byte-identical (up to TTL staleness)`).toBe(stable(before.body));
      expect(stable(first.body), `${r.label}: the first hit renders exactly what the uncached path renders`).toBe(stable(before.body));
      rows.push({ label: r.label, before: { rows: before.rows, queries: before.queries }, first: { rows: first.rows, queries: first.queries }, repeat: { rows: repeat.rows, queries: repeat.queries }, sameBody: true });
    }
    setEdgeCacheEnabled(null);
    const table = ["route\tbefore rows\tbefore q\tafter first rows\tafter first q\tafter repeat rows\tafter repeat q",
      ...rows.map((x) => `${x.label}\t${x.before.rows}\t${x.before.queries}\t${x.first.rows}\t${x.first.queries}\t${x.repeat.rows}\t${x.repeat.queries}`)].join("\n");
    // eslint-disable-next-line no-console
    console.log(`\n${table}\n`);
    expect(rows.every((x) => x.repeat.rows === 0 && x.sameBody)).toBe(true);
  });

  it("a store-scoped read only reads that store's rows (narrowed scans)", async () => {
    await seed();
    setEdgeCacheEnabled(false);
    try {
      const one = await measure(m, () => handleRequest(get(`/flags.json?domain=${D}`), e));
      const all = await measure(m, () => handleRequest(get("/flags.json"), e));
      expect(one.rows).toBeLessThan(all.rows);
      // loadAggregates for ONE store must narrow its flag and tip reads to that store (the whole-index chart still reads all)
      const check = await measure(m, () => handleRequest(get(`/check?domain=${D}`), e));
      expect(check.sqls.find((s) => s.includes("FROM note_flags")) ?? "").toContain("WHERE d = ?");
      expect(check.sqls.find((s) => s.includes("SELECT id, pubkey, d FROM experiences")) ?? "").toContain("AND d = ?");
      const chart = await measure(m, () => handleRequest(get(`/chart.json`), e));
      expect(chart.sqls.find((s) => s.includes("FROM note_flags")) ?? "").not.toContain("WHERE d = ?");
    } finally {
      setEdgeCacheEnabled(null);
    }
  });
});

describe("GO-KM-D1-SCANS cache key discipline (anti-gaming)", () => {
  const key = (path: string, headers: Record<string, string> = {}) => cacheKeyFor(get(path, headers), {});

  it("/q: junk params are dropped, so they cannot mint a new entry", () => {
    expect(key("/q?q=X&junk=1")).toBe(key("/q?q=x"));
    expect(key("/q?q=x&utm_source=spam&foo=bar")).toBe(key("/q?q=x"));
  });

  it("/q: param order, case and documented defaults normalize to one key", () => {
    expect(key("/q?q=x&limit=10")).toBe(key("/q?limit=10&q=X"));
    expect(key("/q?q=x")).toBe(key("/q?q=x&limit=50&scope=any&sort=-btc,-ag,d")); // documented defaults filled
    expect(key("/q?q=x&pay=ln,card")).toBe(key("/q?q=x&pay=card,ln")); // list order does not matter
    expect(key("/q?q=x&category=shopping")).not.toBe(key("/q?q=x")); // real params still separate entries
  });

  it("query/accept variants are separate entries; each route has its own key", () => {
    expect(key("/q?q=x&format=ndjson")).not.toBe(key("/q?q=x"));
    expect(key("/q?q=x", { Accept: "text/html" })).not.toBe(key("/q?q=x"));
    expect(key("/q?q=x")).not.toBe(key("/check?domain=x"));
    expect(key("/chart?limit=10")).not.toBe(key("/chart.json?limit=10"));
  });

  it("routes that must stay uncached are uncached", () => {
    expect(planEdgeCache(new Request("https://klickymart.com/offers?q=x&live=1"), {})).toBeNull();
    expect(planEdgeCache(new Request("https://klickymart.com/reviews", { method: "POST", body: "{}" }), {})).toBeNull();
    expect(planEdgeCache(new Request("https://klickymart.com/submit", { method: "POST", body: "{}" }), {})).toBeNull();
    expect(planEdgeCache(new Request("https://klickymart.com/auth/me"), {})).toBeNull();
    expect(planEdgeCache(new Request("https://klickymart.com/stats/ingest.json"), {})).toBeNull();
    expect(planEdgeCache(new Request("https://klickymart.com/q?q=x"), { KM_EDGE_CACHE: "off" })).toBeNull();
  });

  it("MCP: only the read-only tools are cached, and never a live find_offers", () => {
    const call = (name: string, args: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const ck = (body: string) => cacheKeyFor(new Request("https://klickymart.com/mcp", { method: "POST", body }), {}, body);
    expect(ck(call("search_merchants", { q: "lamp" }))).not.toBeNull();
    expect(ck(call("search_merchants", { q: "Lamp" }))).toBe(ck(call("search_merchants", { q: "lamp" })));
    expect(ck(call("find_offers", { q: "lamp", live: true }))).toBeNull();
    expect(ck(call("submit_review", { event: {} }))).toBeNull();
    expect(ck(call("get_record", { domain: "store.google.com" }))).not.toBeNull();
  });

  it("an equivalent request (defaults spelled out, params reordered) costs 0 D1 rows on /q", async () => {
    setEdgeCacheEnabled(true);
    try {
      await (await handleRequest(get("/q?q=lamp"), e)).text();
      const same = await measure(m, () => handleRequest(get("/q?limit=50&q=lamp&scope=any"), e));
      expect(same.rows).toBe(0); // same cache entry, served from the edge cache
      expect(same.status).toBe(200);
      expect(same.body).toContain("\"total\"");
    } finally {
      setEdgeCacheEnabled(null);
    }
  });
});

describe("GO-KM-D1-SCANS one load per request", () => {
  it("/check reads the flag cache and the tips once, not once per block", async () => {
    await seed();
    setEdgeCacheEnabled(false);
    try {
      await (await handleRequest(get(`/check?domain=${D}`), e)).text(); // warm: /check must not answer from a previous test's cache
      const r = await measure(m, () => handleRequest(get(`/check?domain=${D}`), e));
      const flagReads = r.sqls.filter((s) => s.includes("FROM note_flags")).length;
      const tipReads = r.sqls.filter((s) => s.includes("FROM experiences") && s.includes("SELECT id, pubkey, d")).length;
      expect(flagReads).toBe(1);
      expect(tipReads).toBe(1);
    } finally {
      setEdgeCacheEnabled(null);
    }
  });
});

describe("GO-KM-D1-SCANS takedown filter rewrite is exact", () => {
  const OLD = (t: string) =>
    `${t}.id NOT IN (SELECT h.event_id FROM takedown_hides h WHERE NOT EXISTS (SELECT 1 FROM takedown_restores r WHERE r.event_id = h.event_id AND r.notice_hash = h.notice_hash)) AND ${t}.pubkey NOT IN (SELECT pubkey FROM (SELECT notice_hash, pubkey FROM takedown_notices WHERE valid = 1 AND received_at > unixepoch() - ${365 * 86400} AND notice_hash NOT IN (SELECT notice_hash FROM takedown_restores)) GROUP BY pubkey HAVING COUNT(*) >= 3)`;

  it("NOT IN and the new NOT EXISTS form select the same rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = now - 20 * 86400;
    const a = hex(0xc001), b = hex(0xc002), c = hex(0xc003);
    await env.DB.batch([
      // a: hidden, then restored -> visible
      env.DB.prepare("INSERT OR IGNORE INTO takedown_notices (notice_hash,claimant_hash,pubkey,valid,received_at) VALUES (?,?,?,?,?)").bind(hex(0xd001), hex(0xe1), a, 1, old),
      env.DB.prepare("INSERT OR IGNORE INTO takedown_hides (event_id,notice_hash,hidden_at) VALUES (?,?,?)").bind(hex(0xf001), hex(0xd001), old),
      env.DB.prepare("INSERT OR IGNORE INTO takedown_restores (event_id,notice_hash,counter_hash,restored_at) VALUES (?,?,?,?)").bind(hex(0xf001), hex(0xd001), hex(0xe2), old),
      // b: hidden, still in force
      env.DB.prepare("INSERT OR IGNORE INTO takedown_notices (notice_hash,claimant_hash,pubkey,valid,received_at) VALUES (?,?,?,?,?)").bind(hex(0xd002), hex(0xe1), b, 1, old),
      env.DB.prepare("INSERT OR IGNORE INTO takedown_hides (event_id,notice_hash,hidden_at) VALUES (?,?,?)").bind(hex(0xf002), hex(0xd002), old),
      // c: three valid notices in the window -> every event of that key is hidden
      ...[0, 1, 2].map((i) => env.DB.prepare("INSERT OR IGNORE INTO takedown_notices (notice_hash,claimant_hash,pubkey,valid,received_at) VALUES (?,?,?,?,?)").bind(hex(0xd100 + i), hex(0xe1), c, 1, old)),
      // an invalid notice never counts
      env.DB.prepare("INSERT OR IGNORE INTO takedown_notices (notice_hash,claimant_hash,pubkey,valid,received_at) VALUES (?,?,?,?,?)").bind(hex(0xd200), hex(0xe1), hex(0xc004), 1, now - 400 * 86400),
      ...[0, 1, 2, 3, 4].map((i) => env.DB.prepare("INSERT OR IGNORE INTO experiences (id,kind,d,pubkey,created_at,structured,content,raw_json,source,received_day,basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(hex(0xf100 + i), 422, "td.example.com", [hex(0xf001), hex(0xf002), hex(0xc003), a, b][i]!, now - 100, 1, "x", "{}", "post", "2026-10-01", "visit")),
    ]);
    const oldRows = ((await env.DB.prepare(`SELECT id FROM experiences WHERE ${OLD("experiences")} ORDER BY id`).all<{ id: string }>()).results ?? []).map((r) => r.id);
    const newRows = ((await env.DB.prepare(`SELECT id FROM experiences WHERE ${visibleSql("experiences")} ORDER BY id`).all<{ id: string }>()).results ?? []).map((r) => r.id);
    expect(newRows).toEqual(oldRows);
    // and the rewrite is not vacuous: a hide still in force hides, a restore re-shows, one notice is not a repeat offender
    expect(newRows).not.toContain(hex(0xf102)); // hidden by a notice with no restore
    expect(newRows).toContain(hex(0xf100)); // hidden, then restored by a counter-notice
    expect(newRows).toContain(hex(0xf103)); // one valid notice: visible
    expect(newRows).toContain(hex(0xf104)); // one valid notice: visible
  });
});
