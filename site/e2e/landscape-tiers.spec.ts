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
  // Re-measured 2026-11-02 on the folded home layout (scene band 58..173px at 1280x720):
  // scene-only captures diff = 0.00977 (hero captures = 0.00327, below the floor, because the
  // hero card now covers most of the scene). The scene-only captures do not depend on the hero
  // layout, so compare those and keep the 0.004 floor.
  expectMeaningfulPixelDiff(
    path.join(art, "landscape-tier0-scene-dark-desktop.png"),
    path.join(art, "landscape-tier3-scene-dark-desktop.png"),
    0.004,
  );
});

test("tier 0 scene desktop shows road grid in lower band", () => {
  expectRoadPixelsInLowerBand(path.join(art, "landscape-tier0-scene-dark-desktop.png"), 11);
});

test("tier 0 with hero still shows road above card", () => {
  // Re-measured 2026-11-02 for GO-KM-HOME-SCENE (1280x720): the home hero is now a transparent
  // scrim, so the old 0.48..0.64 band no longer includes the light hero panel that used to inflate
  // the green average (it measured 164.3 mostly from that panel). The neon horizon/road at ~0.50 is
  // still visible through the hero; band 0.495..0.515 measured green avg 166.1 -> min 125 (75%).
  expectRoadPixelsInBand(path.join(art, "landscape-tier0-dark-desktop.png"), 0.495, 0.515, 125);
});

test("default home dark desktop 2d shows neon grid and road", () => {
  // Measured 2026-11-02 (folded layout, 1280x800 2d canvas): the road/grid rows are 0.54..0.62
  // (dark rows 32..36% with neon lines 6..10%); 0.64+ is the dark store list, no road pixels.
  // Measured green avg in 0.54..0.62 = 70.5 -> min 53 (75%).
  expectRoadPixelsInBand(path.join(art, "home-dark-desktop.png"), 0.54, 0.62, 53);
});

test("default home dark mobile 2d shows road band", () => {
  // Measured 2026-11-02 (folded layout, 390x844 2d canvas): the road/grid rows are 0.48..0.54
  // (dark rows 20..79% with neon lines 5..7%); 0.56+ is the card/store list, no road pixels.
  // Measured green avg in 0.48..0.54 = 53.9 -> min 41 (76%).
  expectRoadPixelsInBand(path.join(art, "home-dark-mobile.png"), 0.48, 0.54, 41);
});
