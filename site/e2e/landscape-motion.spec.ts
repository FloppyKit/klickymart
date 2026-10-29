import { test } from "@playwright/test";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { assertWebGLLandscape } from "./landscape-helpers";

test.describe.configure({ mode: "serial" });

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";
const art = path.join("e2e", "artifacts");

test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
});

async function recordTierMotion(tier: number, filename: string, page: import("@playwright/test").Page): Promise<void> {
  mkdirSync(art, { recursive: true });
  await page.addInitScript(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.goto(`${base}/?gl=1&tier=${tier}&btc=0.72&reach=0.55`);
  await assertWebGLLandscape(page, tier);
  await page.waitForTimeout(5000);
  const video = page.video();
  await page.close();
  if (video) {
    await video.saveAs(path.join(art, filename));
  }
}

test("motion tier 2 WebGL highway", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "chromium + SwiftShader only");
  await recordTierMotion(2, "landscape-motion-tier2.webm", page);
});

test("motion tier 3 WebGL highway", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "chromium + SwiftShader only");
  await recordTierMotion(3, "landscape-motion-tier3.webm", page);
});
