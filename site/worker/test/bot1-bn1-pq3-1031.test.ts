import { describe, expect, it } from "vitest";
import { isBolt11Checksum, invoiceFromChallenge, railCheck } from "../src/agent-native";
import { PROBE_402 } from "../src/probe-402";
import botHtml from "../../public/bot/index.html?raw";
import routerSrc from "../src/router.ts?raw";

const SPEC = "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

describe("BOT-1: /bot describes guest checkout and UCP sessions", () => {
  it("says it may start a guest/UCP checkout, stops before payment, never submits, cancels UCP sessions", () => {
    expect(botHtml).not.toMatch(/adding an item to a cart is the furthest it goes/);
    expect(botHtml).toMatch(/guest checkout with a business ship-to/);
    expect(botHtml).toMatch(/UCP checkout session/);
    expect(botHtml).toMatch(/stops before the payment step, never submits an order, and cancels UCP checkout sessions/);
  });
});

describe("BN-1: bolt11 label needs a bech32 checksum", () => {
  it("accepts the spec invoice and rejects tampered / wrong-prefix / junk", () => {
    expect(isBolt11Checksum(SPEC)).toBe(true);
    expect(isBolt11Checksum(SPEC.slice(0, -1) + (SPEC.endsWith("h") ? "g" : "h"))).toBe(false);
    expect(isBolt11Checksum("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(false);
    expect(isBolt11Checksum("lnbcnotaninvoice")).toBe(false);
    expect(isBolt11Checksum(null)).toBe(false);
    expect(invoiceFromChallenge(`L402 macaroon="abc", invoice="${SPEC}"`)).toBe(SPEC);
  });
  it("every verified bolt11 label in probe data rests on a checksummed invoice; others say 'invoice not verified'", () => {
    for (const p of PROBE_402) {
      const rc = railCheck(p.d); if (!rc) continue;
      const b = rc.bolt11_no_browser as Record<string, unknown>;
      if (b.verified) expect(isBolt11Checksum(invoiceFromChallenge(p.challenge))).toBe(true);
      else if (p.result === "verified-402" && p.http === 402 && p.proto === "l402" && !isBolt11Checksum(invoiceFromChallenge(p.challenge)))
        expect(b.label).toBe("L402 challenge (invoice not verified)");
    }
  });
});

describe("PQ-3: pending: KV writes only via enqueuePending", () => {
  it("router has exactly one pending: put, inside enqueuePending (capped)", () => {
    const puts = [...routerSrc.matchAll(/KV!?\.put\(\s*`pending:/g)];
    expect(puts.length).toBe(1);
    const fn = routerSrc.slice(routerSrc.indexOf("export async function enqueuePending"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/KV\.put\(`pending:/);
    expect(body).toMatch(/PENDING_LIMITS\.perIpPerDay/);
    expect(body).toMatch(/PENDING_LIMITS\.globalPerDay/);
    expect(body).toMatch(/PENDING_QUEUE_ENABLED !== "true"/);
  });
  it("no other worker module writes pending: keys", async () => {
    const mods = (import.meta as unknown as { glob: (p: string, o: object) => unknown }).glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [f, src] of Object.entries(mods)) if (!f.endsWith("router.ts")) expect(src, f).not.toMatch(/\.put\(\s*[`"']pending:/);
  });
});
