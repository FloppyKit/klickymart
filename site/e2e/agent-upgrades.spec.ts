import { expect, test } from "@playwright/test";

test("homepage check box answers inline", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/");
  await page.fill("#check-domain", "microsoft.com");
  await page.click('[data-testid="check-form"] button');
  const out = page.locator('[data-testid="check-result"]');
  await expect(out.locator("[data-verdict]")).toHaveAttribute("data-verdict", "blocked-tos", { timeout: 20_000 });
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

for (const scheme of ["dark", "light"] as const) {
  test(`hero check label readable (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/");
    await page.locator('[data-testid="check-form"]').scrollIntoViewIfNeeded();
    const c = await page.evaluate(() => {
      const lum = (s: string) => { const m = s.match(/[\d.]+/g)!.map(Number); const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
      const label = document.querySelector('label[for="check-domain"]')!;
      const hero = document.querySelector(".km-home-hero")!;
      return { fg: lum(getComputedStyle(label).color), dark: document.documentElement.getAttribute("data-theme"), bg: getComputedStyle(hero).backgroundColor };
    });
    // dark scheme: light text; light scheme: dark text on a mostly-opaque light panel
    if (scheme === "dark") expect(c.fg).toBeGreaterThan(0.6);
    else { expect(c.fg).toBeLessThan(0.1); expect(c.bg).toMatch(/oklab|srgb|rgba?\(/); }
    await page.screenshot({ path: `e2e/artifacts/home-check-box-${scheme}-desktop.png` });
  });
}

test("alternatives UI: homepage form and blocked-site suggestions", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/");
  await page.fill("#alt-q", "headphones");
  await page.click('[data-testid="alt-form"] button');
  await expect(page.locator('[data-testid="alt-list"] li').first()).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/alternatives-headphones-dark-desktop.png", fullPage: false });
  await page.goto("/check?format=html&domain=microsoft.com");
  await expect(page.locator('[data-testid="check-alternatives"]')).toContainText("Blocked here? Try these");
  await page.screenshot({ path: "e2e/artifacts/check-blocked-alternatives-dark-desktop.png" });
});
