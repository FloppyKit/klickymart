import { test, expect } from "@playwright/test";
import { waitFor2dLandscape } from "./landscape-helpers";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";

const viewports = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

const schemes = ["dark", "light"] as const;

/** F7: at first load, no scrolling, the search and the first 3 store rows are fully in the viewport. */
for (const vp of viewports) {
  for (const scheme of schemes) {
    test(`home fold ${vp.name} ${scheme}: search and first 3 rows above the fold`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript((s) => localStorage.setItem("km-theme", s as string), scheme);
      await page.goto(`${base}/?nomotion=1`);
      await waitFor2dLandscape(page);

      const viewport = page.viewportSize()!;
      const inside = (b: { x: number; y: number; width: number; height: number } | null, what: string) => {
        expect(b, `${what} has a bounding box`).not.toBeNull();
        const box = b!;
        expect(box.x, `${what} left edge`).toBeGreaterThanOrEqual(0);
        expect(box.y, `${what} top edge`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${what} right edge`).toBeLessThanOrEqual(viewport.width + 0.5);
        expect(box.y + box.height, `${what} bottom edge`).toBeLessThanOrEqual(viewport.height + 0.5);
      };

      // The scene is still drawn as a band and the page did not scroll.
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const scene = await page.locator(".km-home-scene-gap").boundingBox();
      expect(scene!.height).toBeGreaterThan(24);

      inside(await page.locator("#q").boundingBox(), "search input");

      const rows = page.locator(".km-home-list .km-result-row");
      expect(await rows.count()).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < 3; i++) {
        inside(await rows.nth(i).boundingBox(), `store row ${i + 1}`);
      }

      // F4: each first-screen label has a (?) disclosure that opens a plain-language definition.
      for (const [testid, label] of [
        ["def-signed-records", "SIGNED RECORDS"],
        ["def-let-agents-in", "let agents in"],
        ["def-btc-private", "take Bitcoin privately"],
      ] as const) {
        const def = page.getByTestId(testid);
        await expect(def, `${label} definition exists`).toBeVisible();
        await expect(def.locator("summary")).toBeVisible();
        await def.locator("summary").click();
        await expect(def.locator("p"), `${label} definition opens`).toBeVisible();
        await def.locator("summary").click();
      }

      // The labels themselves are on the first screen, with a summary next to each.
      const eyebrow = page.locator(".km-home-hero .km-eyebrow");
      await expect(eyebrow).toContainText("SIGNED RECORDS");
      inside(await eyebrow.locator("summary").boundingBox(), "SIGNED RECORDS (?)");
      const story = page.getByTestId("story-line");
      await expect(story).toContainText("let agents in");
      await expect(story).toContainText("take Bitcoin privately");
      inside(await page.getByTestId("def-let-agents-in").locator("summary").boundingBox(), "let agents in (?)");
      inside(await page.getByTestId("def-btc-private").locator("summary").boundingBox(), "take Bitcoin privately (?)");

      const shot = vp.name === "1280" ? "home-fold-1280.png" : "home-fold-390.png";
      if (scheme === "dark") {
        await page.screenshot({ path: `e2e/artifacts/${shot}`, animations: "disabled", fullPage: false });
      } else {
        await page.screenshot({ path: `e2e/artifacts/${shot.replace(".png", "-light.png")}`, animations: "disabled", fullPage: false });
      }
    });
  }
}
