import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { handleRequest, isProduction, saltRequiredButMissing } from "../src/router";
import TOML from "../../wrangler.toml?raw";
import DOC from "../../docs/DEPLOY-lnurlp-zap.md?raw";

describe("R12-005 SUBMIT_SALT required in production", () => {
  it("detects production and a missing salt", () => {
    expect(isProduction({ ENVIRONMENT: "production" })).toBe(true);
    expect(isProduction({ SITE_ORIGIN: "https://klickymart.com/" })).toBe(true);
    expect(isProduction({ SITE_ORIGIN: "https://example.com" })).toBe(false);
    expect(saltRequiredButMissing({ ENVIRONMENT: "production" })).toBe(true);
    expect(saltRequiredButMissing({ ENVIRONMENT: "production", SUBMIT_SALT: "x" })).toBe(false);
    expect(saltRequiredButMissing({})).toBe(false);
  });
  it("rate-limited endpoints return 503 in production without the salt", async () => {
    const e = { ...(env as any), ENVIRONMENT: "production", SUBMIT_SALT: undefined };
    for (const [m, p] of [["POST", "/tip/invoice"], ["POST", "/feed/list-check"], ["GET", "/tip-ready.json?pubkeys=" + "a".repeat(64)], ["GET", "/.well-known/lnurlp/zap"]] as const) {
      const r = await handleRequest(new Request("https://example.com" + p, { method: m, ...(m === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) }), e);
      expect(r.status, p).toBe(503);
    }
  });
  it("production config and deploy docs require it", () => {
    expect(TOML as string).toMatch(/\[env\.production\.vars\][\s\S]*ENVIRONMENT = "production"/);
    expect(DOC as string).toMatch(/SUBMIT_SALT.*REQUIRED/);
  });
});
