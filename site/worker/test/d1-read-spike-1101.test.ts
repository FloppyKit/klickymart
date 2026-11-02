import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { keyFirstSeen, KEY_FIRST_SEEN_CHUNK } from "../src/key-age";
import { visibleSql } from "../src/takedown";

// 2026-11-01 D1 read spike: scraper hit /merchant/<domain> ~500x at ~1.2k rows each. Fix 1: i_site_records_d.
// Fix 2: keyFirstSeen scoped to the keys the caller needs.
const OLD = [
  `SELECT pubkey, MIN(first_seen) AS t FROM nostr_events WHERE ${visibleSql("nostr_events")} GROUP BY pubkey`,
  `SELECT pubkey, MIN(unixepoch(received_day)) + 86399 AS t FROM experiences WHERE ${visibleSql("experiences")} GROUP BY pubkey`,
  `SELECT pubkey, MIN(unixepoch(received_day)) + 86399 AS t FROM reviews WHERE ${visibleSql("reviews")} GROUP BY pubkey`,
];
async function oldKeyFirstSeen(db: D1Database) {
  const out = new Map<string, number>();
  for (const q of OLD) for (const r of (await db.prepare(q).all<{ pubkey: string; t: number | null }>()).results ?? []) if (typeof r.t === "number") out.set(r.pubkey, Math.min(out.get(r.pubkey) ?? Infinity, r.t));
  return out;
}
const hex = (n: number) => n.toString(16).padStart(64, "0");

describe("D1 read spike 2026-11-01", () => {
  it("scoped keyFirstSeen equals the old whole-table result on a fixture (incl. >1 chunk and mixed sources)", async () => {
    const N = KEY_FIRST_SEEN_CHUNK * 2 + 7; const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < N; i++) {
      const pk = hex(0xa000 + i);
      stmts.push(env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind(hex(0x100000 + i), 1, pk, 5, null, "{}", 1_700_000_000 + i, "t"));
      stmts.push(env.DB.prepare("INSERT INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind(hex(0x200000 + i), 1, pk, 5, null, "{}", 1_700_000_000 + i + 50, "t"));
      if (i % 3 === 0) stmts.push(env.DB.prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,content,raw_json,source,received_day,basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(hex(0x300000 + i), 422, "eq.example.com", pk, 5, 1, "s", "{}", "post", "2023-01-01", "visit"));
    }
    await env.DB.batch(stmts);
    const old = await oldKeyFirstSeen(env.DB);
    const all = [...old.keys()];
    const scoped = await keyFirstSeen(env.DB, all);
    expect(scoped.size).toBe(old.size);
    for (const [k, v] of old) expect(scoped.get(k)).toBe(v);
    // subset: only the asked keys come back, same values
    const sub = all.slice(3, 40); const s2 = await keyFirstSeen(env.DB, [...sub, ...sub, "ff".repeat(32)]);
    expect([...s2.keys()].sort()).toEqual([...sub].sort());
    for (const k of sub) expect(s2.get(k)).toBe(old.get(k));
  });
  it("empty input returns empty without a query", async () => {
    let calls = 0; const spy = new Proxy(env.DB, { get(t, p) { if (p === "prepare" || p === "batch" || p === "exec") calls++; const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; } });
    expect((await keyFirstSeen(spy, [])).size).toBe(0); expect(calls).toBe(0);
  });
  it("site_records d lookup uses i_site_records_d; scoped first-seen uses the pubkey indexes", async () => {
    const plan = async (q: string, ...b: unknown[]) => ((await env.DB.prepare(`EXPLAIN QUERY PLAN ${q}`).bind(...b).all<{ detail: string }>()).results ?? []).map((r) => r.detail).join(" | ");
    expect(await plan("SELECT pubkey, id, created_at, raw_json, relays FROM site_records WHERE d = ?", "x.com")).toContain("i_site_records_d");
    const p = await plan("SELECT pubkey, MIN(first_seen) AS t FROM nostr_events WHERE pubkey IN (?, ?) GROUP BY pubkey", "a", "b");
    expect(p).toMatch(/USING (COVERING )?INDEX (i_ne_pk|sqlite_autoindex)/);
    expect(await plan("SELECT pubkey, MIN(received_day) FROM experiences WHERE pubkey IN (?, ?) GROUP BY pubkey", "a", "b")).toContain("i_exp_pk");
    expect(await plan("SELECT pubkey, MIN(received_day) FROM reviews WHERE pubkey IN (?, ?) GROUP BY pubkey", "a", "b")).toContain("i_reviews_pk_day");
  });
});
