import { describe, it, expect } from "vitest";
import { validateClaimDomain } from "../src/claim";
import botHtml from "../../bot/index.html?raw";

describe("claim validator", () => {
  it("rejects localhost and IPs", () => {
    expect(validateClaimDomain("localhost").ok).toBe(false);
    expect(validateClaimDomain("127.0.0.1").ok).toBe(false);
    expect(validateClaimDomain("http://evil.com").ok).toBe(false);
  });
});

describe("bot page text preserved", () => {
  it("contains all original sentences", () => {
    const html = botHtml;
    expect(html).toContain("FloppyKitMapBot is the crawler behind KlickyMart");
    expect(html).toContain("Solve or bypass captchas");
    expect(html).toContain("User-agent: FloppyKitMapBot");
  });
});
