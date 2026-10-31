import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitFor2dLandscape, expectLandscapeInViewportCanvas } from "./landscape-helpers";

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
      if (el.closest(".km-landscape-wrap")) return;
      if (el.classList.contains("km-grade")) return;
      // n-of-N data bars are an intentional BTC-orange accent fill, not a surface.
      if (el.classList.contains("km-hbar")) return;
      // Agent-native status chips are intentional colored labels, not page surfaces.
      if (el.classList.contains("badge")) return;
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

const pages = [
  "/",
  "/dashboard",
  "/merchant/start9.com",
  "/merchant/cryptocloaks.com",
  "/merchant/netflix.com",
  "/merchant/booking.com",
  "/claim",
  "/about",
  "/contribute",
  "/docs/api",
  "/docs/nostr-tags",
  "/bot",
];

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
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1280, height: 800 });
      for (const [name, path] of [
        ["home", "/"],
        ["dashboard", "/dashboard"],
        ["merchant-start9", "/merchant/start9.com"],
        ["merchant-cryptocloaks", "/merchant/cryptocloaks.com"],
        ["merchant-anw", "/merchant/netflix.com"],
        ["merchant-blocked-tos", "/merchant/booking.com"],
        ["claim", "/claim"],
      ] as const) {
        await page.goto(`${base}${path === "/" ? "/?nomotion=1" : path}`);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        if (path === "/") {
          await page.waitForSelector(".km-copy");
          await waitFor2dLandscape(page);
        }
        await page.waitForTimeout(path === "/" ? 500 : 200);
        if (path === "/") {
          await page.screenshot({
            path: `e2e/artifacts/${name}-${theme}-desktop.png`,
            fullPage: false,
            clip: { x: 0, y: 0, width: 1280, height: 800 },
            timeout: 30_000,
            animations: "disabled",
          });
        } else {
          await page.screenshot({
            path: `e2e/artifacts/${name}-${theme}-desktop.png`,
            fullPage: true,
            timeout: 30_000,
            animations: "disabled",
          });
        }
      }
      for (const [stage, qs] of [
        ["landscape-live", "?nomotion=1"],
        ["landscape-low", "?reach=0.12&btc=0.04&nomotion=1"],
        ["landscape-mid", "?reach=0.52&btc=0.45&nomotion=1"],
        ["landscape-high", "?reach=0.88&btc=0.92&nomotion=1"],
      ] as const) {
        await page.goto(`${base}/${qs}`);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        await waitFor2dLandscape(page);
        await page.waitForTimeout(900);
        await page.screenshot({
          path: `e2e/artifacts/home-${stage}-${theme}-desktop.png`,
          fullPage: false,
          clip: { x: 0, y: 0, width: 1280, height: 720 },
          timeout: 30_000,
          animations: "disabled",
        });
      }
      for (const [stage, qs] of [
        ["landscape-live", "?nomotion=1"],
        ["landscape-low", "?reach=0.12&btc=0.04&nomotion=1"],
      ] as const) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${base}/${qs}`);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        await waitFor2dLandscape(page);
        await page.waitForTimeout(900);
        await page.screenshot({
          path: `e2e/artifacts/home-${stage}-${theme}-mobile.png`,
          fullPage: false,
          clip: { x: 0, y: 0, width: 390, height: 844 },
          timeout: 30_000,
          animations: "disabled",
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [name, path] of [
        ["home", "/"],
        ["dashboard", "/dashboard"],
        ["merchant-start9", "/merchant/start9.com"],
      ] as const) {
        await page.goto(`${base}${path === "/" ? "/?nomotion=1" : path}`);
        await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
        if (path === "/") {
          await page.waitForSelector(".km-copy");
          await waitFor2dLandscape(page);
          await page.waitForTimeout(500);
          await page.screenshot({
            path: `e2e/artifacts/${name}-${theme}-mobile.png`,
            fullPage: false,
            clip: { x: 0, y: 0, width: 390, height: 844 },
            timeout: 30_000,
            animations: "disabled",
          });
        } else {
          await page.screenshot({
            path: `e2e/artifacts/${name}-${theme}-mobile.png`,
            fullPage: true,
            timeout: 30_000,
            animations: "disabled",
          });
        }
      }
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

test("footer signoff on home", async ({ page }) => {
  await page.goto(`${base}/`);
  await expect(page.getByText("Thank You, Come Again.")).toBeVisible();
});

test("search start9 finds start9.com", async ({ page }) => {
  await page.goto(`${base}/?q=start9`);
  await expect(page.getByText("start9.com", { exact: false })).toBeVisible();
});

test("stats reflects at least the 250-site pilot", async ({ request }) => {
  const res = await request.get(`${base}/stats`);
  expect(res.ok()).toBeTruthy();
  const j = (await res.json()) as { records?: number; by_status?: Record<string, number> };
  // Dataset grows past the pilot; assert sane lower bounds, not an exact size.
  expect(j.records ?? 0).toBeGreaterThanOrEqual(250);
  expect(j.by_status?.crawled ?? 0).toBeGreaterThanOrEqual(121);
  expect(j.by_status?.crawled ?? 0).toBeLessThanOrEqual(j.records ?? 0);
});

test("default homepage lists real merchants only (no .example)", async ({ page }) => {
  await page.addInitScript(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.goto(`${base}/`);
  await page.waitForSelector(".km-results");
  const text = await page.locator(".km-results").innerText();
  expect(text).not.toMatch(/\.example/i);
  expect(text).not.toMatch(/Example Shop/i);
  await expect(page.getByText("start9.com", { exact: false })).toBeVisible();
});

test("advertised agent routes respond", async ({ request }) => {
  const exp = await request.get(`${base}/export.ndjson?limit=2`);
  expect(exp.status()).toBe(200);
  expect(exp.headers()["content-type"]).toContain("ndjson");
  const body = await exp.text();
  expect(body.trim().split("\n").length).toBeGreaterThanOrEqual(1);

  const mcp = await request.post(`${base}/mcp`, {
    data: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    headers: { "Content-Type": "application/json" },
  });
  expect(mcp.status()).toBe(200);
  const j = (await mcp.json()) as { result?: { tools?: unknown[] } };
  expect(j.result?.tools?.length).toBeGreaterThanOrEqual(2);
});

test("home dark desktop capture shows synthwave canvas", () => {
  expectLandscapeInViewportCanvas("e2e/artifacts/home-dark-desktop.png", 12);
});
