import { test, expect } from "@playwright/test";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";

async function waitLandscape(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __kmLandscapeReady?: boolean }).__kmLandscapeReady === true, {
    timeout: 20_000,
  });
  await page.waitForTimeout(1000);
}

for (const tier of [0, 1, 2, 3] as const) {
  for (const [suffix, viewport] of [
    ["desktop", { width: 1280, height: 720 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    test(`landscape tier ${tier} ${suffix}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/?tier=${tier}&btc=0.6&reach=0.5`);
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await waitLandscape(page);
      await page.screenshot({
        path: `e2e/artifacts/landscape-tier${tier}-dark-${suffix}.png`,
        fullPage: false,
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      });
      const fidelity = await page.evaluate(() => (window as unknown as { __kmLandscapeFidelity?: number }).__kmLandscapeFidelity);
      if (typeof fidelity === "number") {
        expect(fidelity).toBeCloseTo(tier, 0);
      }
    });
  }
}

for (const [suffix, viewport] of [
  ["desktop", { width: 1280, height: 720 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`landscape tier 2 light ${suffix}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${base}/?tier=2&btc=0.5`);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await waitLandscape(page);
    await page.screenshot({
      path: `e2e/artifacts/landscape-tier2-light-${suffix}.png`,
      fullPage: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    });
  });
}
