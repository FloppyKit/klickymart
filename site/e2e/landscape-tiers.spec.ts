import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  assertWebGLLandscape,
  expectMeaningfulPixelDiff,
  expectRoadPixelsInBand,
  expectRoadPixelsInLowerBand,
} from "./landscape-helpers";

test.describe.configure({ mode: "serial" });

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";
const art = path.join("e2e", "artifacts");

for (const tier of [0, 1, 2, 3] as const) {
  for (const [suffix, viewport] of [
    ["desktop", { width: 1280, height: 720 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    test(`landscape tier ${tier} ${suffix} (WebGL)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(() => {
        document.documentElement.setAttribute("data-theme", "dark");
      });
      await page.goto(`${base}/?gl=1&tier=${tier}&btc=0.65&reach=0.5`);
      await assertWebGLLandscape(page, tier);
      await page.screenshot({
        path: path.join(art, `landscape-tier${tier}-dark-${suffix}.png`),
        fullPage: false,
        clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
      });
    });

    test(`landscape tier ${tier} ${suffix} scene-only (WebGL)`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(() => {
        document.documentElement.setAttribute("data-theme", "dark");
      });
      await page.goto(`${base}/?gl=1&tier=${tier}&btc=0.65&reach=0.5&scene=1`);
      await assertWebGLLandscape(page, tier);
      await page.screenshot({
        path: path.join(art, `landscape-tier${tier}-scene-dark-${suffix}.png`),
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
    await page.addInitScript(() => {
      document.documentElement.setAttribute("data-theme", "light");
    });
    await page.goto(`${base}/?gl=1&tier=2&btc=0.55`);
    await assertWebGLLandscape(page, 2);
    await page.screenshot({
      path: path.join(art, `landscape-tier2-light-${suffix}.png`),
      fullPage: false,
      clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    });
  });
}

test("tier 0 vs tier 3 desktop pixels differ (richer detail, same scene)", () => {
  expectMeaningfulPixelDiff(
    path.join(art, "landscape-tier0-dark-desktop.png"),
    path.join(art, "landscape-tier3-dark-desktop.png"),
    0.004,
  );
});

test("tier 0 scene desktop shows road grid in lower band", () => {
  expectRoadPixelsInLowerBand(path.join(art, "landscape-tier0-scene-dark-desktop.png"), 11);
});

test("tier 0 with hero still shows road above card", () => {
  expectRoadPixelsInBand(path.join(art, "landscape-tier0-dark-desktop.png"), 0.36, 0.58, 28);
});

test("default home dark desktop 2d shows neon grid and road", () => {
  expectRoadPixelsInBand(path.join(art, "home-dark-desktop.png"), 0.48, 0.92, 18);
});

test("default home dark mobile 2d shows road band", () => {
  expectRoadPixelsInBand(path.join(art, "home-dark-mobile.png"), 0.52, 0.92, 16);
});
