import { test, expect } from "@playwright/test";
import { waitFor2dLandscape } from "./landscape-helpers";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";

async function darkHome(page: import("@playwright/test").Page, qs: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("km-theme", "dark"));
  await page.goto(`${base}/${qs}`);
  await waitFor2dLandscape(page);
}

test("story line is computed from live data", async ({ page, request }) => {
  const stats = (await (await request.get(`${base}/stats`)).json()) as { records: number; by_status: Record<string, number> };
  await darkHome(page, "?nomotion=1");
  const story = await page.getByTestId("story-line").innerText();
  expect(story).toMatch(new RegExp(`^\\d+ of ${stats.records} stores let agents in\\. \\d+ takes? Bitcoin privately\\. Watch the sun rise\\.$`));
  await expect(page.getByText("The road fills in as stores open to agents; the sun rises as private Bitcoin spreads.")).toBeVisible();
  const reachable = await page.locator("#km-landscape").getAttribute("data-reachable");
  expect(story.startsWith(`${reachable} of `)).toBe(true);
});

test("store and shoppers follow reach and btc overrides", async ({ page }) => {
  await darkHome(page, "?reach=0.2&btc=0.1&nomotion=1");
  const low = await page.locator("#km-landscape").evaluate((c) => ({ ...(c as HTMLCanvasElement).dataset }));
  expect(low.storeOpen).toBe("0");
  expect(Number(low.shoppers)).toBe(3);
  expect(Number(low.shoppersOrange)).toBe(0);

  await page.goto(`${base}/?reach=0.9&btc=0.8&nomotion=1`);
  await waitFor2dLandscape(page);
  const high = await page.locator("#km-landscape").evaluate((c) => ({ ...(c as HTMLCanvasElement).dataset }));
  expect(high.storeOpen).toBe("1");
  expect(Number(high.shoppers)).toBe(8);
  expect(Number(high.shoppersOrange)).toBe(6);
  expect(Number(high.storeLitWindows)).toBeGreaterThan(Number(low.storeLitWindows));
});

test("store look screenshots", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [name, qs] of [
    ["landscape-store-low", "?reach=0.2&btc=0.1&nomotion=1"],
    ["landscape-store-high", "?reach=0.9&btc=0.8&nomotion=1"],
  ] as const) {
    await darkHome(page, qs);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `e2e/artifacts/${name}-dark-desktop.png`, clip: { x: 0, y: 0, width: 1280, height: 800 }, animations: "disabled" });
  }
  await darkHome(page, "?nomotion=1");
  await page.waitForSelector(".km-copy");
  await page.locator(".km-store").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, (document.querySelector(".km-store") as HTMLElement).getBoundingClientRect().top + window.scrollY - 60));
  await page.waitForTimeout(400);
  await page.screenshot({ path: "e2e/artifacts/home-list-dark-desktop.png", animations: "disabled" });
  await page.evaluate(() => window.scrollTo(0, (document.querySelector(".km-staff") as HTMLElement).getBoundingClientRect().top + window.scrollY - 200));
  await page.waitForTimeout(300);
  await page.screenshot({ path: "e2e/artifacts/home-agents-dark-desktop.png", animations: "disabled" });
  await page.goto(`${base}/dashboard`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "e2e/artifacts/dashboard-top-dark-desktop.png", animations: "disabled" });
});
