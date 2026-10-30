import { expect, test } from "@playwright/test";

test("homepage check box answers inline", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/");
  await page.fill("#check-domain", "microsoft.com");
  await page.click('[data-testid="check-form"] button');
  const out = page.locator('[data-testid="check-result"]');
  await expect(out.locator("[data-verdict]")).toHaveAttribute("data-verdict", "blocked-tos");
  await page.locator('[data-testid="check-form"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/artifacts/home-check-box-dark-desktop.png" });
  await page.fill("#check-domain", "not-indexed.test");
  await page.click('[data-testid="check-form"] button');
  await expect(out).toContainText("not in index yet");
  await page.screenshot({ path: "e2e/artifacts/home-check-box-unknown-dark-desktop.png" });
});

test("about shows MCP install snippets and simulated-shopper note", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/about#mcp");
  await expect(page.locator("#mcp")).toBeVisible();
  await expect(page.locator("body")).toContainText("mcp-remote");
  await expect(page.locator("body")).toContainText("partly simulated");
  const canvas = page.locator("#km-landscape");
  await expect(canvas).toHaveAttribute("data-shoppers-simulated", /\d+/);
  await page.locator("#agents").screenshot({ path: "e2e/artifacts/about-agents-mcp-dark-desktop.png" });
  await page.screenshot({ path: "e2e/artifacts/about-dark-desktop-agents.png", fullPage: true });
});
