import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import * as secp from "@noble/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { nostrEventId } from "../src/nostr-verify";
import { isQueueableHost, PENDING_LIMITS } from "../src/router";

const KV = () => (env as unknown as { KV: KVNamespace }).KV;
const DB = () => (env as unknown as { DB: D1Database }).DB;
const day = () => new Date().toISOString().slice(0, 10);
const newKey = () => secp.utils.randomSecretKey();
function sign(sk: Uint8Array, d: string) {
  const ev = { pubkey: bytesToHex(secp.schnorr.getPublicKey(sk)), created_at: Math.floor(Date.now() / 1000), kind: 422, tags: [["r", d], ["basis", "visit"], ["depth", "payment"], ["rating", "4", "5"]], content: "reached payment " + Math.random() };
  const id = nostrEventId(ev);
  return { ...ev, id, sig: bytesToHex(secp.schnorr.sign(hexToBytes(id), sk)) };
}
const onEnv = () => ({ ...(env as unknown as Record<string, unknown>), PENDING_QUEUE_ENABLED: "true" }) as never;
async function post(ev: unknown, ip = "203.0.113.1") {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const r = await worker.fetch(new Request("https://klickymart.com/reviews", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(ev) }), onEnv(), ctx);
  await Promise.allSettled(waits);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
const queued = async (d: string) => (await KV().get(`pending:${d}`)) !== null;
const rnd = () => Math.random().toString(36).slice(2, 8);

describe("PQ-1 pending-crawl queue written only after acceptance, with caps", () => {
  it("accepted note for a new domain is queued once (deduped)", async () => {
    const d = `pq-ok-${rnd()}.com`;
    const a = await post(sign(newKey(), d), "203.0.113.50");
    expect(a.status).toBe(201);
    expect(await queued(d)).toBe(true);
    const first = await KV().get(`pending:${d}`);
    const b = await post(sign(newKey(), d), "203.0.113.51");
    expect(b.status).toBe(201);
    expect(await KV().get(`pending:${d}`)).toBe(first);
  });
  it("tombstoned note is not queued", async () => {
    const d = `pq-tomb-${rnd()}.com`;
    const ev = sign(newKey(), d);
    await DB().prepare("INSERT INTO tombstones (id, pubkey, deletion_id, deleted_at) VALUES (?, ?, NULL, ?)").bind(ev.id, ev.pubkey, Date.now()).run();
    const r = await post(ev, "203.0.113.60");
    expect(r.status).toBe(410);
    expect(await queued(d)).toBe(false);
  });
  it("rate-limited note is not queued", async () => {
    const sk = newKey();
    let last = { status: 0, body: {} as Record<string, unknown> }; let d = "";
    for (let i = 0; i < 8 && last.status !== 429; i++) { d = `pq-rl-${i}-${rnd()}.com`; last = await post(sign(sk, d), `198.51.100.${i + 1}`); }
    expect(last.status).toBe(429);
    expect(await queued(d)).toBe(false);
  });
  it("per-key daily cap", async () => {
    const sk = newKey();
    await KV().put(`pq:k:${day()}:${bytesToHex(secp.schnorr.getPublicKey(sk))}`, String(PENDING_LIMITS.perKeyPerDay));
    const d = `pq-key-${rnd()}.com`;
    const r = await post(sign(sk, d), "203.0.113.70");
    expect(r.status).toBe(201);
    expect(r.body.pending_crawl).toMatchObject({ status: "not queued" });
    expect(await queued(d)).toBe(false);
  });
  it("per-IP daily cap", async () => {
    const ip = "192.0.2.77";
    for (let i = 0; i < PENDING_LIMITS.perIpPerDay; i++) { const d = `pq-ip-${i}-${rnd()}.com`; expect((await post(sign(newKey(), d), ip)).status).toBe(201); expect(await queued(d)).toBe(true); }
    const d = `pq-ip-over-${rnd()}.com`;
    expect((await post(sign(newKey(), d), ip)).status).toBe(201);
    expect(await queued(d)).toBe(false);
  });
  it("global daily cap", async () => {
    await KV().put(`pq:g:${day()}`, String(PENDING_LIMITS.globalPerDay));
    const d = `pq-global-${rnd()}.com`;
    expect((await post(sign(newKey(), d), "203.0.113.90")).status).toBe(201);
    expect(await queued(d)).toBe(false);
    await KV().delete(`pq:g:${day()}`);
  });
});

describe("PQ-2 junk-host reject list", () => {
  it.each(["shop.internal", "printer.local", "app.localhost", "localhost", "abc.onion", "x.invalid", "store.test", "store.example", "127.0.0.1", "10.0.0.1", "[::1]", "::1", "intranet", "a.b.home.arpa"])("rejects %s", (h) => expect(isQueueableHost(h)).toBe(false));
  it.each(["shop.example.com", "store.co.uk", "acme.io"])("accepts %s", (h) => expect(isQueueableHost(h)).toBe(true));
  it("junk host note is not queued", async () => {
    const r = await post(sign(newKey(), "shop.internal"), "203.0.113.99");
    expect(r.status).not.toBe(201);
    expect(await queued("shop.internal")).toBe(false);
  });
});
