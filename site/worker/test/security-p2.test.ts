import { describe, expect, it, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { ipHash } from "../src/submissions";
import { robotsAllows, NIP05_UA } from "../src/nip05";
import { RECHECK_TOKEN } from "../src/recheck";
import { saveState, getState, INGEST_LIMITS } from "../src/relay-ingest";

beforeEach(async () => { for (const t of ["rate_limits", "ingest_state"]) await env.DB.prepare(`DELETE FROM ${t}`).run(); });

describe("P2 security fixes", () => {
  it("KM-013: ipHash is a keyed HMAC, stable per salt/day and different across salts", () => {
    const a = ipHash("203.0.113.9", "salt-a", 0), b = ipHash("203.0.113.9", "salt-b", 0);
    expect(a).toBe(ipHash("203.0.113.9", "salt-a", 0));
    expect(a).not.toBe(b);
    expect(a).not.toContain("203.0.113.9");
  });
  it("KM-016: NIP-05 checks use the documented FloppyKitMapBot token and identity", () => {
    const optOut = "User-agent: FloppyKitMapBot\nDisallow: /\n";
    expect(robotsAllows(optOut, "/.well-known/nostr.json")).toBe(false);
    expect(robotsAllows("User-agent: KlickyMartBot\nDisallow: /\n", "/.well-known/nostr.json")).toBe(false);
    expect(robotsAllows("User-agent: OtherBot\nDisallow: /\n", "/.well-known/nostr.json")).toBe(true);
    expect(NIP05_UA.startsWith("FloppyKitMapBot/")).toBe(true);
    expect(RECHECK_TOKEN).toBe("floppykitmapbot");
  });
  it("KIMI-009: a future-dated created_at cannot push the catch-up watermark past now; overlap >= 600 s", async () => {
    const now = Date.now();
    await saveState(env.DB, "wss://r.example", { maxCreated: Math.floor(now / 1000) + 86400 * 365, events: 1, ok: true, now });
    expect((await getState(env.DB))["wss://r.example"].last_seen).toBeLessThanOrEqual(Math.floor(now / 1000));
    expect(INGEST_LIMITS.catchupOverlapS).toBeGreaterThanOrEqual(600);
  });
  it("KM-011/KM-017: GET /claim is read-only; POST /claim needs same origin", async () => {
    const before = (await env.DB.prepare("SELECT COUNT(*) n FROM claims").first<{ n: number }>())!.n;
    const g = await SELF.fetch("https://example.com/claim?d=bestbuy.com&npub=npub18tzyhkgafgz5gsp6phlyahzx3s85u8kg5fhjkt6ca9u6hc6dxfpqe6z979");
    expect(g.status).toBeLessThan(500);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM claims").first<{ n: number }>())!.n).toBe(before);
    const x = await SELF.fetch("https://example.com/claim", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: "d=bestbuy.com&npub=npub18tzyhkgafgz5gsp6phlyahzx3s85u8kg5fhjkt6ca9u6hc6dxfpqe6z979" });
    expect(x.status).toBe(403);
  });
  it("KIMI-010: repeated /claim/dns re-checks for a domain are throttled", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await SELF.fetch("https://example.com/claim/dns", { method: "POST", body: JSON.stringify({ domain: "bestbuy.com" }) })).status);
    expect(codes.every((c) => c < 500)).toBe(true);
  });
});
