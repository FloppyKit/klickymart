import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleDnsClaim } from "../src/dns-claim";
import { ipHash, submitStore } from "../src/submissions";

const PK = "ab".repeat(32);
async function activeClaim(domain: string) {
  await env.DB.prepare("INSERT OR REPLACE INTO store_claims (domain,pubkey,method,status,txt,event_id,claimed_at,checked_at) VALUES (?,?,?,?,?,?,?,?)").bind(domain, PK, "dns", "active", null, "cd".repeat(32), 1, 1).run();
}
describe("KIMI-010: DNS re-check throttle is reached and fails closed", () => {
  it("second re-check of the same domain within 10 min is 429 and does no lookup", async () => {
    await activeClaim("throttle-test.com"); let lookups = 0; const lookup = async () => { lookups++; return [] as string[]; };
    const now = Date.UTC(2026, 9, 30, 12);
    const a = await handleDnsClaim(env.DB, { domain: "throttle-test.com" }, { lookup, now, dryRun: true });
    const b = await handleDnsClaim(env.DB, { domain: "throttle-test.com" }, { lookup, now: now + 1000, dryRun: true });
    expect(a.status).toBe(200); expect(b.status).toBe(429); expect(lookups).toBe(1);
  });
  it("a throttle storage error refuses (429) without any lookup", async () => {
    await activeClaim("broken-test.com"); let lookups = 0; const lookup = async () => { lookups++; return [] as string[]; };
    const db = new Proxy(env.DB, { get(t, k) { if (k === "prepare") return (q: string) => { if (/rate_limits/.test(q)) throw new Error("boom"); return t.prepare(q); }; const v = (t as any)[k]; return typeof v === "function" ? v.bind(t) : v; } }) as D1Database;
    const r = await handleDnsClaim(db, { domain: "broken-test.com" }, { lookup, dryRun: true });
    expect(r.status).toBe(429); expect(lookups).toBe(0);
  });
});
describe("R5-005: no per-isolate salt fallback", () => {
  it("unsalted ipHash is one shared bucket with nothing IP-derived; submissions refuse without SUBMIT_SALT", async () => {
    expect(ipHash("1.2.3.4", "")).toBe("unsalted"); expect(ipHash("5.6.7.8", "")).toBe("unsalted");
    expect(ipHash("1.2.3.4", "s")).not.toBe(ipHash("5.6.7.8", "s"));
    const r = await submitStore({ domain: "example.org" } as never, { db: env.DB, indexed: new Set(), salt: "", ip: "1.2.3.4", via: "post", dryRun: true, origin: "https://klickymart.com" } as never);
    expect(r.status).toBe(503);
  });
});
