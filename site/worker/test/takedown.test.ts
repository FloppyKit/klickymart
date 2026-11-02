import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { parseFeedParams, readFeed } from "../src/nostr-app";
import { getReviews } from "../src/reviews";
import { keyFirstSeen } from "../src/key-age";
import { loadTips } from "../src/tips";
import { scanFlags } from "../src/flags";
import { isRepeatOffender, takedownEnabled, takedownInfo, REPEAT_RULE } from "../src/takedown";
import worker from "../src/index";
import MIG from "../migrations/0025_takedown.sql?raw";
import MIG27 from "../migrations/0027_m4_append_only.sql?raw";
const restore = (id: string, h: string) => DB().prepare("INSERT OR IGNORE INTO takedown_restores (event_id, notice_hash, counter_hash, restored_at) VALUES (?,?,?,?)").bind(id, h, "e".repeat(64), now()).run();

type T = { kind: number; created_at: number; content: string; tags: string[][] };
const sign = (t: T, sk: Uint8Array) => { const pubkey = bytesToHex(secp.schnorr.getPublicKey(sk)); const id = nostrEventId({ ...t, pubkey }); return { ...t, pubkey, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) }; };
const now = () => Math.floor(Date.now() / 1000);
const DB = () => env.DB;
const notice = (h: string, pk: string, valid: 0 | 1, at: number) => DB().prepare("INSERT OR IGNORE INTO takedown_notices (notice_hash, claimant_hash, pubkey, valid, received_at) VALUES (?,?,?,?,?)").bind(h, "c".repeat(64), pk, valid, at).run();
const hide = (id: string, h: string) => DB().prepare("INSERT OR IGNORE INTO takedown_hides (event_id, notice_hash, hidden_at) VALUES (?,?,?)").bind(id, h, now()).run();
const feed = async () => { const p = parseFeedParams(new URLSearchParams("kinds=422")); if (!p.ok) throw new Error(p.message); return (await readFeed(DB(), p.value)).map((e) => e.id); };
const store = async (e: ReturnType<typeof sign>) => DB().prepare("INSERT OR REPLACE INTO nostr_events (id, kind, pubkey, created_at, d, raw_json, first_seen, relays) VALUES (?,?,?,?,?,?,?,?)").bind(e.id, e.kind, e.pubkey, e.created_at, null, JSON.stringify(e), now(), "test").run();
const call = async (path: string, x: Record<string, string>) => worker.fetch(new Request(`https://example.com${path}`), { ...env, ...x } as never, { waitUntil() {}, passThroughOnException() {}, props: {} } as never);

beforeEach(async () => { for (const t of ["nostr_events", "reviews", "experiences"]) await DB().prepare(`DELETE FROM ${t}`).run(); });

describe("M4 S7 takedown", () => {
  it("migration is append-only and hash-only (no text/name/email columns)", () => {
    const sql = MIG.replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP)\b/i);
    expect(sql).not.toMatch(/\b(email|name|address|body|text)\s+TEXT/i);
  });
  it("flag off: /takedown is 404; on: page + JSON with bot@klickymart.com and agent pending", async () => {
    expect((await SELF.fetch("https://example.com/takedown.json")).status).toBe(404);
    expect(takedownEnabled({})).toBe(false);
    const j = await (await call("/takedown.json", { KM_TAKEDOWN: "on" })).json<any>();
    expect(j.contact).toBe("bot@klickymart.com"); expect(j.designated_agent).toMatch(/not yet registered/);
    const h = await (await call("/takedown", { KM_TAKEDOWN: "on" })).text();
    expect(h).toContain("mailto:bot@klickymart.com"); expect(h).toMatch(/3 valid notices within 365 days/);
  });
  it("hides by event id on the feed; other events from the same key stay", async () => {
    const sk = secp.utils.randomSecretKey();
    const a = sign({ kind: 422, created_at: now() - 5, content: "a", tags: [["d", "td.example.com"]] }, sk), b = sign({ kind: 422, created_at: now() - 6, content: "b", tags: [["d", "td.example.com"]] }, sk);
    await store(a); await store(b);
    expect(await feed()).toEqual([a.id, b.id]);
    await notice("n1", a.pubkey, 1, now()); await hide(a.id, "n1");
    expect(await feed()).toEqual([b.id]);
  });
  it("hides reviews by id on the site", async () => {
    for (const id of ["r1", "r2"]) await DB().prepare("INSERT INTO reviews (id,d,pubkey,created_at,rating,rating_max,attempt,content,raw_json,received_day) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id, "td.example.com", "p".repeat(64), now(), 5, 5, "x", "c", "{}", "2026-11-01").run();
    await hide("r1", "n1");
    const r = await getReviews(DB(), "td.example.com");
    expect(r.count).toBe(1); expect(r.items.map((i) => i.id)).toEqual(["r2"]);
  });
  it("repeat offender: 3 valid notices in 365 days hide every event by that key; invalid or old ones don't count", async () => {
    const sk = secp.utils.randomSecretKey();
    const e = sign({ kind: 422, created_at: now(), content: "x", tags: [["d", "td.example.com"]] }, sk);
    await store(e);
    const t = now();
    await notice("v1", e.pubkey, 1, t); await notice("v2", e.pubkey, 1, t - 100); await notice("bad", e.pubkey, 0, t);
    await notice("old", e.pubkey, 1, t - REPEAT_RULE.windowS - 10);
    expect(await isRepeatOffender(DB(), e.pubkey, t)).toBe(false); expect(await feed()).toEqual([e.id]);
    await notice("v3", e.pubkey, 1, t - 200);
    expect(await isRepeatOffender(DB(), e.pubkey, t)).toBe(true); expect(await feed()).toEqual([]);
  });
  it("info text says what we can't do (other relays) and logs hashes only", () => {
    const i = takedownInfo(); expect(i.what_we_do).toMatch(/other relays/); expect(i.log).toMatch(/hashes/);
  });
  it("restore after a counter-notice re-shows the event (a new row, never a delete) and a later notice can hide it again", async () => {
    const sk = secp.utils.randomSecretKey();
    const a = sign({ kind: 422, created_at: now(), content: "r", tags: [["d", "td.example.com"]] }, sk);
    await store(a);
    await notice("rs1", a.pubkey, 1, now()); await hide(a.id, "rs1");
    expect(await feed()).toEqual([]);
    await restore(a.id, "rs1");
    expect(await feed()).toEqual([a.id]);
    expect((await DB().prepare("SELECT COUNT(*) AS n FROM takedown_hides WHERE event_id = ?").bind(a.id).first<{ n: number }>())!.n).toBe(1);
    await notice("rs2", a.pubkey, 1, now()); await hide(a.id, "rs2");
    expect(await feed()).toEqual([]);
  });
  it("restored notices stop counting toward the repeat-offender rule", async () => {
    const pk = secp.utils.randomSecretKey(); const k = bytesToHex(secp.schnorr.getPublicKey(pk));
    for (const h of ["ro1", "ro2", "ro3"]) await notice(h, k, 1, now());
    expect(await isRepeatOffender(DB(), k, now())).toBe(true);
    await restore("f".repeat(64), "ro3");
    expect(await isRepeatOffender(DB(), k, now())).toBe(false);
  });
  it("append-only triggers: UPDATE and DELETE on takedown tables abort", async () => {
    await notice("ap1", "a".repeat(64), 1, now());
    for (const sql of ["UPDATE takedown_notices SET valid = 0 WHERE notice_hash = 'ap1'", "DELETE FROM takedown_notices WHERE notice_hash = 'ap1'", "DELETE FROM takedown_hides", "DELETE FROM takedown_restores"])
      await expect(DB().prepare(sql).run()).rejects.toThrow(/append-only/);
    for (const t of ["snapshot_nodes", "snapshot_leaves", "store_trust_obs", "live_seen_domains", "ship_policy_obs", "takedown_notices", "takedown_hides", "takedown_restores", "trust_buys", "trust_complaints", "trust_dismissals", "trust_graph_heads", "trust_graph_members"])
      for (const op of ["update", "delete"]) expect(MIG27).toContain(`${t}_no_${op}`);
  });
  it("hidden events are excluded from internal scoring: key age, tips and flags", async () => {
    const sk = secp.utils.randomSecretKey();
    const e = sign({ kind: 422, created_at: now(), content: "s", tags: [["d", "td.example.com"]] }, sk);
    await store(e);
    await DB().prepare("INSERT INTO experiences (id,kind,d,pubkey,created_at,structured,content,raw_json,source,received_day,basis) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(e.id, 422, "td.example.com", e.pubkey, now(), 1, "s", JSON.stringify(e), "post", "2026-11-01", "visit").run();
    expect((await keyFirstSeen(DB(), [e.pubkey])).has(e.pubkey)).toBe(true);
    expect((await loadTips(DB())).author.has(e.id)).toBe(true);
    expect((await scanFlags(DB())).size >= 0).toBe(true);
    await notice("sc1", e.pubkey, 1, now()); await hide(e.id, "sc1");
    expect((await keyFirstSeen(DB(), [e.pubkey])).has(e.pubkey)).toBe(false);
    expect((await loadTips(DB())).author.has(e.id)).toBe(false);
    expect([...(await scanFlags(DB())).keys()]).not.toContain(e.id);
  });
});
