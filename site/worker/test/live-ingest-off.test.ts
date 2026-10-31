import { describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import worker from "../src/index";
import { RelayIngester, liveIngestEnabled } from "../src/ingester-do";

function fakeState(alarm: number | null) {
  const calls: string[] = [];
  let a = alarm;
  const storage = {
    getAlarm: async () => a,
    setAlarm: async (t: number) => { calls.push("set"); a = t; },
    deleteAlarm: async () => { calls.push("delete"); a = null; },
  };
  return { state: { storage } as unknown as DurableObjectState, calls, alarm: () => a };
}

describe("LIVE_INGEST off (default)", () => {
  it("is off unless explicitly enabled", () => {
    expect(liveIngestEnabled({})).toBe(false);
    expect(liveIngestEnabled({ LIVE_INGEST: "0" })).toBe(false);
    expect(liveIngestEnabled({ LIVE_INGEST: "1" })).toBe(true);
    expect(liveIngestEnabled({ LIVE_INGEST: "true" })).toBe(true);
  });

  it("DO fetch closes sockets, deletes the alarm, never re-arms", async () => {
    const s = fakeState(Date.now() + 30_000);
    const doObj = new RelayIngester(s.state, { RELAY_URLS: "wss://x.test" } as never);
    let closed = false;
    (doObj as unknown as { live: Map<string, unknown> }).live.set("wss://x.test", { ws: { close: () => { closed = true; } }, state: "open" });
    const r = await doObj.fetch(new Request("https://ingester/ensure"));
    expect(await r.json()).toEqual({ disabled: true });
    expect(closed).toBe(true);
    expect(s.calls).toEqual(["delete"]);
    expect(s.alarm()).toBeNull();
  });

  it("DO alarm deletes the alarm and does not re-arm", async () => {
    const s = fakeState(Date.now());
    await new RelayIngester(s.state, {} as never).alarm();
    expect(s.calls).toEqual(["delete"]);
    expect(s.alarm()).toBeNull();
  });

  it("cron does not touch the DO but still runs catch-up", async () => {
    let touched = 0;
    const INGESTER = { idFromName: () => { touched++; return {}; }, get: () => { touched++; return { fetch: async () => new Response("{}") }; } };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    let prepared = 0;
    const DB = new Proxy(env.DB, { get(t, k) { if (k === "prepare") prepared++; const v = Reflect.get(t, k); return typeof v === "function" ? v.bind(t) : v; } });
    await worker.scheduled!({} as ScheduledController, { ...env, DB, INGESTER, RELAY_URLS: "", LIVE_INGEST: undefined } as never, ctx);
    await Promise.all(waits);
    expect(touched).toBe(0);
    expect(prepared).toBeGreaterThan(0); // ingestCtx/catch-up reached D1
  });

  it("/stats/ingest.json reports live:{disabled:true}", async () => {
    const r = await SELF.fetch("https://klickymart.com/stats/ingest.json");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { live: unknown }).live).toEqual({ disabled: true });
  });
});
