import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { BUFFER_LIMITS, catchUp, parseFrame, type Connect } from "../src/relay-ingest";

/** A hostile relay: floods EVENT frames on every REQ and never sends EOSE. */
function floodRelay(n: number, frameBytes = 200): Connect {
  return async () => {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    server.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as unknown[];
      if (msg[0] !== "REQ") return;
      const junk = { kind: 1, content: "x".repeat(frameBytes) };
      for (let i = 0; i < n; i++) server.send(JSON.stringify(["EVENT", msg[1], junk]));
    });
    client.accept();
    return client as never;
  };
}

describe("KIMI-008: bounded relay buffers", () => {
  it("oversize frames are dropped before JSON parsing", () => {
    expect(parseFrame(JSON.stringify(["EVENT", "s", { content: "x".repeat(BUFFER_LIMITS.maxFrameBytes) }]))).toBeNull();
    expect(parseFrame(JSON.stringify(["EVENT", "s", { content: "ok" }]))?.type).toBe("EVENT");
  });
  it("a flooding catch-up relay is cut off at the event cap instead of growing without bound", async () => {
    const r = await catchUp(env.DB, ["wss://flood.test"], { domains: new Set(["dell.com"]), ourPubkey: null }, floodRelay(BUFFER_LIMITS.catchupMaxEvents + 500), 5000);
    const out = r["wss://flood.test"]!;
    expect(out.error).toMatch(/catch-up cap reached/);
    expect(out.accepted + out.rejected + out.duplicate).toBeLessThanOrEqual(BUFFER_LIMITS.catchupMaxEvents);
  });
});
