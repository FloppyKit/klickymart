import { describe, expect, it } from "vitest";
import { privateIp, readCapped, validRelayUrl } from "../src/tip-rails";
import { publicHost } from "../src/nostr-app";

describe("R9-005 capped body read", () => {
  it("refuses by Content-Length and by streamed size; reads small bodies", async () => {
    expect(await readCapped(new Response("x".repeat(10), { headers: { "content-length": "999999" } }), 100)).toBeNull();
    const big = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(64)); } }); // endless
    expect(await readCapped(new Response(big), 1000)).toBeNull();
    expect(await readCapped(new Response("héllo"), 100)).toBe("héllo");
  });
});

describe("R9-006 privateIp / publicHost gaps", () => {
  it("catches hex-mapped IPv6, site-local, 6to4, Teredo and bracketed forms", () => {
    for (const ip of ["::ffff:7f00:1", "::7f00:1", "::ffff:a00:1", "[::1]", "fec0::1", "2002:7f00:1::", "2001:0:abcd::1", "100::1", "192.88.99.1", "1.2.3.300"]) expect(privateIp(ip), ip).toBe(true);
    for (const ip of ["93.184.215.14", "2606:4700::6810:85e5"]) expect(privateIp(ip), ip).toBe(false);
  });
  it("rejects IP-ish hostnames and malformed labels", () => {
    for (const h of ["0x7f.0.0.1", "0177.0.0.1", "a..b", ".a.com", "a.com.", "-a.com", "a.123", "localhost"]) expect(publicHost(h), h).toBe(false);
    for (const h of ["primal.net", "relay.damus.io", "x-1.example.com"]) expect(publicHost(h), h).toBe(true);
    expect(validRelayUrl("wss://user:pw@relay.damus.io")).toBe(false);
    expect(validRelayUrl("wss://relay.damus.io/path")).toBe(true);
  });
});
