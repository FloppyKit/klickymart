import { describe, it, expect } from "vitest";
import { privateIp } from "../src/tip-rails";
import { publicHost } from "../src/nostr-app";
import { isQueueableHost } from "../src/router";
import { isSpecialUseHost } from "../src/special-names";
import { readCapped } from "../src/capped-read";

describe("GP-4 privateIp parses addresses numerically", () => {
  it.each([
    "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::1", "::", "0:0:0:0:0:0:0:0",
    "::ffff:7f00:1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:10.0.0.1", "::127.0.0.1", "::7f00:1", "::ffff:a9fe:a9fe",
    "[::1]", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "3fff::1", "64:ff9b::7f00:1", "2002::1", "fec0::1",
    "127.0.0.1", "0x7f.0.0.1", "0177.0.0.1", "2130706433", "127.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1",
    "999.1.1.1", "not-an-ip", "1::2::3", "",
  ])("%s is private / refused", (ip) => expect(privateIp(ip)).toBe(true));
  it.each(["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "0:0:0:0:0:ffff:808:808", "172.32.0.1", "100.128.0.1"])(
    "%s is public", (ip) => expect(privateIp(ip)).toBe(false));
});

describe("GP-5 shared special-use-name helper", () => {
  const bad = ["relay.example", "x.alt", "a.localdomain", "a.internal", "a.local", "localhost", "a.localhost", "a.invalid", "a.test", "a.onion",
    "a.arpa", "router.home.arpa", "a.home", "a.lan", "a.corp", "a.intranet", "a.private", "example", "singlelabel", "127.0.0.1", "0x7f.0.0.1", "1.2.3.4", "::1", "[::1]", "shop.example."];
  it.each(bad)("%s rejected by helper, publicHost and isQueueableHost", (h) => {
    expect(isSpecialUseHost(h)).toBe(true);
    expect(publicHost(h)).toBe(false);
    expect(isQueueableHost(h)).toBe(false);
  });
  it.each(["relay.damus.io", "primal.net", "shop.example.com", "my-alt.com", "local.store"])("%s allowed", (h) => {
    expect(isSpecialUseHost(h)).toBe(false);
    expect(publicHost(h)).toBe(true);
    expect(isQueueableHost(h)).toBe(true);
  });
});

describe("GP-4 capped reader", () => {
  it("returns null over the cap and text under it", async () => {
    expect(await readCapped(new Response("x".repeat(100)), 50)).toBeNull();
    expect(await readCapped(new Response("hello"), 50)).toBe("hello");
  });
});
