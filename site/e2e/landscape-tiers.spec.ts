import { test, expect } from "@playwright/test";
import path from "node:path";
import { assertWebGLLandscape, expectMeaningfulPixelDiff } from "./landscape-helpers";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";
const art = path.join("e2e", "artifacts");

for (const tier of [0, 1, 2, 3] as const) {
  for (const [suffix, viewport] of [
    ["desktop", { width: 1280, height: 720 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    test(`landscape tier ${tier} ${suffix} (WebGL)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${base}/?tier=${tier}&btc=0.65&reach=0.5`);
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await assertWebGLLandscape(page, tier);
      await page.screenshot({
        path: path.join(art, `landscape-tier${tier}-dark-${suffix}.png`),
        fullPage: false,
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      });
    });
  }
}

for (const [suffix, viewport] of [
  ["desktop", { width: 1280, height: 720 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`landscape tier 2 light ${suffix} (WebGL)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${base}/?tier=2&btc=0.55`);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await assertWebGLLandscape(page, 2);
    await page.screenshot({
      path: path.join(art, `landscape-tier2-light-${suffix}.png`),
      fullPage: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    });
  });
}

test("tier 0 vs tier 3 desktop pixels differ meaningfully", () => {
  expectMeaningfulPixelDiff(
    path.join(art, "landscape-tier0-dark-desktop.png"),
    path.join(art, "landscape-tier3-dark-desktop.png"),
    0.02,
  );
});

test("tier 1 vs tier 3 desktop pixels differ meaningfully", () => {
  expectMeaningfulPixelDiff(
    path.join(art, "landscape-tier1-dark-desktop.png"),
    path.join(art, "landscape-tier3-dark-desktop.png"),
    0.015,
  );
});
