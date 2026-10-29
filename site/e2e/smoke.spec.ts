import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";

const pages = ["/", "/dashboard", "/merchant/microsoft.com", "/claim", "/about", "/contribute", "/docs/api", "/bot"];

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({
      colorScheme: theme,
      viewport: { width: 1280, height: 720 },
    });

    for (const path of pages) {
      test(`page ${path} loads`, async ({ page }) => {
        await page.goto(`${base}${path}`);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        await expect(page.locator("main")).toBeVisible();
        const results = await new AxeBuilder({ page }).analyze();
        const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(serious).toEqual([]);
      });
    }

    test("screenshots", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      for (const [name, path] of [
        ["home", "/"],
        ["merchant", "/merchant/dell.com"],
        ["claim", "/claim"],
      ] as const) {
        await page.goto(`${base}${path}`);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        await page.screenshot({ path: `e2e/artifacts/${name}-${theme}-desktop.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/`);
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.screenshot({ path: `e2e/artifacts/home-${theme}-mobile.png`, fullPage: true });
    });
  });
}

test("search dell finds dell.com", async ({ page }) => {
  await page.goto(`${base}/?q=dell`);
  await expect(page.getByText("dell.com", { exact: false })).toBeVisible();
});

test("dashboard dark backgrounds luminance", async ({ page }) => {
  await page.goto(`${base}/dashboard`);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const bad = await page.evaluate(() => {
    const els = document.querySelectorAll("*");
    const out: string[] = [];
    els.forEach((el) => {
      if (el.classList.contains("km-skip") || el.tagName === "SELECT" || el.tagName === "OPTION") return;
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return;
      const r = Number(m[1]) / 255;
      const g = Number(m[2]) / 255;
      const b = Number(m[3]) / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum > 0.2) out.push(`${el.tagName}.${el.className} ${bg}`);
    });
    return out.slice(0, 5);
  });
  expect(bad).toEqual([]);
});
