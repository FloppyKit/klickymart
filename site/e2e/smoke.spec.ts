import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";

/** Spec §4.2: dark theme must not show UA-default light control surfaces. */
async function expectNoLightControlSurfaces(page: Page, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForLoadState("networkidle");
  if (path === "/") {
    await page.waitForSelector(".km-copy", { timeout: 10_000 });
  }
  const bad = await page.evaluate(() => {
    const controls = document.querySelectorAll("button, input, select, textarea");
    const out: string[] = [];
    controls.forEach((el) => {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return;
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      if (r >= 200 && g >= 200 && b >= 200) {
        out.push(`${el.tagName}.${el.className} ${bg}`);
      }
    });
    return out;
  });
  expect(bad, `light native control backgrounds on ${path}`).toEqual([]);
}

async function expectDarkBackgroundRule(page: Page, path: string): Promise<void> {
  await page.goto(`${base}${path}`);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForLoadState("networkidle");
  if (path === "/") {
    await page.waitForSelector(".km-copy", { timeout: 10_000 });
  }
  const bad = await page.evaluate(() => {
    const els = document.querySelectorAll("*");
    const out: string[] = [];
    els.forEach((el) => {
      if (el.classList.contains("km-skip")) return;
      const tag = el.tagName;
      if (tag === "OPTION") return;
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return;
      const r = Number(m[1]) / 255;
      const g = Number(m[2]) / 255;
      const b = Number(m[3]) / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (tag === "SELECT") return;
      if (lum > 0.2) out.push(`${tag}.${el.className} ${bg}`);
    });
    return out.slice(0, 8);
  });
  expect(bad, `backgrounds too light on ${path}`).toEqual([]);
}

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
        ["dashboard", "/dashboard"],
        ["merchant", "/merchant/dell.com"],
        ["claim", "/claim"],
      ] as const) {
        await page.goto(`${base}${path}`);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        if (path === "/") await page.waitForSelector(".km-copy");
        await page.screenshot({ path: `e2e/artifacts/${name}-${theme}-desktop.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/`);
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForSelector(".km-copy");
      await page.screenshot({ path: `e2e/artifacts/home-${theme}-mobile.png`, fullPage: true });
    });
  });
}

test.describe("dark theme surfaces", () => {
  test("home: no light form controls", async ({ page }) => {
    await expectNoLightControlSurfaces(page, "/");
  });

  test("dashboard: no light form controls", async ({ page }) => {
    await expectNoLightControlSurfaces(page, "/dashboard");
  });

  test("dashboard: background luminance rule", async ({ page }) => {
    await expectDarkBackgroundRule(page, "/dashboard");
  });
});

test("search dell finds dell.com", async ({ page }) => {
  await page.goto(`${base}/?q=dell`);
  await expect(page.getByText("dell.com", { exact: false })).toBeVisible();
});
