import { wipe } from "./helpers/wipe";
import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { QUEUE_DAILY_CAP, appendObs, crawlQueueEnabled, obsId, queueDomains, validateObs } from "../src/trust-obs";

const VEC = "42d5d635c3361bc0f6bf73b46b644dd4defec618bb23c74cceaaee3a16b6a526"; // same vector in crawler/tests/test_trust_obs.py // secret-scan: allow (sha256 test vector shared with the crawler test, not a key)
const AT = 1_793_000_000;
const mk = (o: Partial<Record<string, unknown>> = {}) => {
  const base = { domain: "a.com", signal: "return_policy", value_json: '{"window_days":30}', evidence_url: "https://a.com/policies/refund-policy", quote: "Returns within 30 days.", method: "shopify-policy-page", observed_at: AT, ...o };
  return { ...base, id: obsId(base.domain as string, base.signal as string, base.value_json as string), ...("id" in o ? { id: o.id } : {}) };
};

describe("trust observations: fixed format", () => {
  it("id vector matches the Python crawler", () => expect(obsId("shop.example", "first_seen", '{"at":"2026-01-01T00:00:00Z"}')).toBe(VEC));
  it("a good row validates", () => expect(validateObs(mk()).ok).toBe(true));
  const bad: [string, unknown][] = [
    ["extra field", { ...mk(), extra: 1 }],
    ["missing field", (({ quote: _q, ...x }) => x)(mk())],
    ["wrong id", mk({ id: "0".repeat(64) })],
    ["unknown signal", mk({ signal: "tips" })],
    ["unknown method", mk({ method: "guess" })],
    ["www domain", mk({ domain: "www.a.com" })],
    ["no quote on a policy value", mk({ quote: null })],
    ["no evidence on a known value", mk({ evidence_url: null })],
    ["http evidence", mk({ evidence_url: "http://a.com/x" })],
    ["bad json", mk({ value_json: "{" })],
    ["quote > 500", mk({ quote: "x".repeat(501) })],
  ];
  for (const [n, x] of bad) it(`rejects: ${n}`, () => expect(validateObs(x).ok).toBe(false));
  it("unknown (null) values need no evidence or quote; own-ledger first_seen needs no URL; reseller with no signs needs no quote", () => {
    expect(validateObs(mk({ value_json: "null", evidence_url: null, quote: null })).ok).toBe(true);
    expect(validateObs(mk({ signal: "first_seen", method: "own-ledger", value_json: '{"at":"2026-01-01T00:00:00Z"}', evidence_url: null, quote: null })).ok).toBe(true);
    expect(validateObs(mk({ signal: "reseller", method: "products-json", value_json: '{"signs":[]}', quote: null })).ok).toBe(true);
    expect(validateObs(mk({ signal: "reseller", method: "products-json", value_json: '{"signs":["asin"]}', quote: null })).ok).toBe(false);
  });
});

describe("store_trust_obs: append-only", () => {
  beforeEach(async () => { await wipe(env.DB, ["store_trust_obs"]); });
  it("same value twice = one row (first observation kept); changed value = new row; bad rows rejected", async () => {
    expect((await appendObs(env.DB, [mk(), mk({ observed_at: AT + 86400 })])).inserted).toBe(1);
    const r = await appendObs(env.DB, [mk({ value_json: '{"window_days":14}', quote: "14 days." }), { nope: 1 }]);
    expect(r.inserted).toBe(1); expect(r.rejected).toHaveLength(1);
    const rows = (await env.DB.prepare("SELECT value_json, observed_at FROM store_trust_obs ORDER BY observed_at, value_json").all()).results;
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ observed_at: AT });
  });
});

describe("live_seen_domains: domain only, flag default off", () => {
  beforeEach(async () => { await wipe(env.DB, ["live_seen_domains"]); });
  const n = async () => (await env.DB.prepare("SELECT COUNT(*) AS c FROM live_seen_domains").first<{ c: number }>())!.c;
  it("off by default: writes nothing", async () => {
    expect(crawlQueueEnabled({})).toBe(false);
    expect(await queueDomains({ DB: env.DB }, ["a.com"], AT)).toBe(0); expect(await n()).toBe(0);
  });
  it("on: normalized, deduped, invalid dropped; only the domain column exists", async () => {
    const e = { DB: env.DB, KM_CRAWL_QUEUE: "on" };
    expect(await queueDomains(e, ["WWW.A.com", "a.com", null, "not a domain", "b.shop", "https://x"], AT)).toBe(2);
    expect(await queueDomains(e, ["a.com"], AT + 5)).toBe(0); // already queued
    const cols = (await env.DB.prepare("PRAGMA table_info(live_seen_domains)").all<{ name: string }>()).results.map((c) => c.name).sort();
    expect(cols).toEqual(["domain", "first_seen_at", "source"]);
    expect(await n()).toBe(2);
  });
  it("daily cap", async () => {
    const e = { DB: env.DB, KM_CRAWL_QUEUE: "on" };
    const day0 = AT - (AT % 86400);
    const stmts = Array.from({ length: QUEUE_DAILY_CAP - 1 }, (_, i) => env.DB.prepare("INSERT INTO live_seen_domains VALUES (?,?,?)").bind(`f${i}.com`, day0 + 1, "live-catalog"));
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    expect(await queueDomains(e, ["x1.com", "x2.com", "x3.com"], AT)).toBe(1);
  });
});
