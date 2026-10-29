import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";

test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
});

test("highway drive toward sun (tier 2)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "video recording on chromium only");
  mkdirSync("e2e/artifacts", { recursive: true });
  await page.goto(`${base}/?tier=2&btc=0.72&reach=0.55`);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForFunction(() => (window as unknown as { __kmLandscapeReady?: boolean }).__kmLandscapeReady === true, {
    timeout: 20_000,
  });
  await page.waitForTimeout(4500);
  const video = page.video();
  await page.close();
  if (video) {
    await video.saveAs("e2e/artifacts/landscape-motion.webm");
  }
});
