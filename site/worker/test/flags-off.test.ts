import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";

function sign(tags: string[][]) {
  const sk = secp.utils.randomSecretKey();
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000), kind: 422, tags, content: "reached payment" };
  const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}

const offEnv = () => ({ ...(env as unknown as Record<string, unknown>), CHECKOUT_QUOTES_ENABLED: undefined, PENDING_QUEUE_ENABLED: "false" }) as never;
const call = async (url: string, init?: RequestInit) => {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const r = await worker.fetch(new Request(url, init), offEnv(), ctx);
  await Promise.allSettled(waits);
  return r;
};

describe("flags off (default)", () => {
  it("/landed/notes is disabled", async () => {
    const r = await call("https://klickymart.com/landed/notes?domain=rc-store.example&zip3=660");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ disabled: true, notes: [] });
  });
  it("/landed ignores checkout quotes", async () => {
    const r = await call("https://klickymart.com/landed?q=shirt&zip=66044");
    const b = (await r.json()) as { items?: { landed?: Record<string, unknown> }[] };
    for (const i of b.items ?? []) expect(i.landed?.agent_checkout_quotes).toBeUndefined();
  });
  it("/pending.json is empty even with KV entries", async () => {
    await (env as { KV: KVNamespace }).KV.put("pending:queued-off.example", JSON.stringify({ queued_at: "2026-10-31T00:00:00Z" }));
    const r = await call("https://klickymart.com/pending.json");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ count: 0, items: [] });
  });
  it("review POST for an unindexed store saves but does not queue", async () => {
    const d = "flagsoff-unindexed-example.com";
    const ev = sign([["r", d], ["basis", "visit"], ["depth", "payment"], ["rating", "4", "5"]]);
    const r = await call("https://klickymart.com/reviews", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev) });
    const b = (await r.json()) as Record<string, unknown>;
    expect(r.status).toBeLessThan(300);
    expect(b).toMatchObject({ ok: true, store_indexed: false, pending_crawl: null });
    expect(await (env as { KV: KVNamespace }).KV.get(`pending:${d}`)).toBeNull();
  });
});
