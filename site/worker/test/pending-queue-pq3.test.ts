import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { enqueuePending, PENDING_LIMITS } from "../src/router";

const KV = () => (env as unknown as { KV: KVNamespace }).KV;
const withFlag = (v?: string) => ({ ...(env as unknown as Record<string, unknown>), PENDING_QUEUE_ENABLED: v }) as never;
const rnd = () => Math.random().toString(36).slice(2, 8);
const day = () => new Date().toISOString().slice(0, 10);

describe("PQ-3 /landed live-search pending writes use flag + caps", () => {
  it("flag off (unset or not exactly 'true') writes nothing", async () => {
    for (const v of [undefined, "1", "TRUE", "yes"]) {
      const d = `pq3-off-${rnd()}.com`;
      const r = await enqueuePending(withFlag(v), d, null, "198.51.100.1");
      expect(r.status).toBe("not queued");
      expect(await KV().get(`pending:${d}`)).toBeNull();
    }
  });
  it("junk hosts are not queued", async () => {
    for (const d of ["localhost", "foo.internal", "10.0.0.1", "shop.onion"]) {
      await enqueuePending(withFlag("true"), d, null, "198.51.100.2");
      expect(await KV().get(`pending:${d}`)).toBeNull();
    }
  });
  it("per-IP cap holds with no key", async () => {
    const ip = `198.51.100.${10 + Math.floor(Math.random() * 200)}`;
    const ok: string[] = [];
    for (let i = 0; i < PENDING_LIMITS.perIpPerDay + 3; i++) {
      const d = `pq3-ip-${rnd()}.com`;
      const r = await enqueuePending(withFlag("true"), d, null, ip);
      if (r.status === "pending check") ok.push(d);
    }
    expect(ok.length).toBe(PENDING_LIMITS.perIpPerDay);
  });
  it("global cap holds", async () => {
    await KV().put(`pq:g:${day()}`, String(PENDING_LIMITS.globalPerDay));
    const d = `pq3-g-${rnd()}.com`;
    const r = await enqueuePending(withFlag("true"), d, null, "198.51.100.250");
    expect(r.reason).toMatch(/cap/);
    expect(await KV().get(`pending:${d}`)).toBeNull();
    await KV().delete(`pq:g:${day()}`);
  });
});
