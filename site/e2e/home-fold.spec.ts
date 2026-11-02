import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitFor2dLandscape } from "./landscape-helpers";

const base = process.env.KM_BASE ?? "http://127.0.0.1:8787";

const viewports = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
] as const;

const schemes = ["dark", "light"] as const;

/** F7 (relaxed by GO-KM-HOME-SCENE): at first load, no scrolling, the search is fully in view and the
 *  top edge of the first store row is in view. The scene band is allowed to grow back. */
for (const vp of viewports) {
  for (const scheme of schemes) {
    test(`home fold ${vp.name} ${scheme}: search and first row top edge above the fold`, async ({ page }) => {
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

      // The search input is fully in view.
      inside(await page.locator("#q").boundingBox(), "search input");

      // The top edge of the first store row is in view (a peek is enough).
      const rows = page.locator(".km-home-list .km-result-row");
      expect(await rows.count()).toBeGreaterThanOrEqual(1);
      const firstRow = await rows.first().boundingBox();
      expect(firstRow, "first store row has a bounding box").not.toBeNull();
      expect(firstRow!.y, "first store row top edge is in view").toBeGreaterThanOrEqual(0);
      expect(firstRow!.y, "first store row top edge is above the fold").toBeLessThan(viewport.height);

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

      await page.screenshot({
        path: `e2e/artifacts/home-scene-${vp.name}-${scheme}.png`,
        animations: "disabled",
        fullPage: false,
      });
    });
  }
}

/** GO-KM-HOME-SCENE: the scene is not buried. Sample points above the hero text and on either side of it
 *  must not be covered by any element with an opaque background (or by a store/hero panel). */
for (const vp of viewports) {
  for (const scheme of schemes) {
    test(`home scene visible ${vp.name} ${scheme}: no opaque panel over the scene`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript((s) => localStorage.setItem("km-theme", s as string), scheme);
      await page.goto(`${base}/?nomotion=1`);
      await waitFor2dLandscape(page);

      const hero = await page.locator(".km-home-hero").boundingBox();
      expect(hero, "hero has a bounding box").not.toBeNull();
      const h = hero!;
      const points: [number, number][] =
        vp.width >= 1000
          ? [
              [h.x + h.width * 0.25, h.y - 24],
              [h.x + h.width * 0.75, h.y - 24],
              [h.x - 40, h.y + h.height * 0.3],
              [h.x - 40, h.y + h.height * 0.7],
              [h.x + h.width + 40, h.y + h.height * 0.3],
              [h.x + h.width + 40, h.y + h.height * 0.7],
            ]
          : [
              [h.x + h.width * 0.2, h.y - 20],
              [h.x + h.width * 0.5, h.y - 20],
              [h.x + h.width * 0.8, h.y - 20],
            ];
      expect(points.length).toBe(vp.width >= 1000 ? 6 : 3);

      const hits = await page.evaluate((pts) => {
        const panelSel = [".km-store", ".km-result-row", ".km-hero-panel", ".km-home-hero"];
        const alphaOf = (css: string) => {
          const c = document.createElement("canvas");
          c.width = c.height = 1;
          const ctx = c.getContext("2d")!;
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
        };
        return pts.map(([x, y]) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { x, y, tag: null, cls: null, opaque: null, panel: null };
          const chain: Element[] = [];
          let n: Element | null = el;
          while (n && n !== document.body && n !== document.documentElement) {
            chain.push(n);
            n = n.parentElement;
          }
          const opaque = chain.find((e) => alphaOf(getComputedStyle(e).backgroundColor) > 0.5);
          const panel = chain.find((e) => panelSel.some((s) => e.matches(s)));
          return {
            x,
            y,
            tag: el.tagName,
            cls: typeof el.className === "string" ? el.className : null,
            opaque: opaque ? (typeof opaque.className === "string" ? opaque.className : opaque.tagName) : null,
            panel: panel ? (typeof panel.className === "string" ? panel.className : panel.tagName) : null,
          };
        });
      }, points);

      for (const hit of hits) {
        expect(hit.tag, `point ${hit.x},${hit.y} hits an element`).not.toBeNull();
        expect(hit.opaque, `point ${hit.x},${hit.y} is not covered by an opaque background`).toBeNull();
        expect(hit.panel, `point ${hit.x},${hit.y} is not covered by a store/hero panel`).toBeNull();
      }
    });
  }
}

/** GO-KM-HOME-SCENE: light mode is tinted to the scene, not white panels. */
for (const vp of viewports) {
  test(`home light mode ${vp.name}: store sheet and rows are not near-white`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.addInitScript(() => localStorage.setItem("km-theme", "light"));
    await page.goto(`${base}/?nomotion=1`);
    await waitFor2dLandscape(page);

    const colors = await page.evaluate(() => {
      const toRgb = (css: string) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const ctx = c.getContext("2d")!;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!];
      };
      const store = document.querySelector(".km-page-home .km-store")!;
      const row = document.querySelector(".km-page-home .km-result-row")!;
      return {
        store: toRgb(getComputedStyle(store).backgroundColor),
        row: toRgb(getComputedStyle(row).backgroundColor),
      };
    });

    for (const [name, rgb] of [
      ["store sheet", colors.store],
      ["result row", colors.row],
    ] as const) {
      const nearWhite = rgb[0] >= 245 && rgb[1] >= 245 && rgb[2] >= 245;
      expect(nearWhite, `${name} background rgb(${rgb.join(",")}) must not be near-white`).toBe(false);
    }
  });
}

/** GO-KM-HOME-SCENE-FIX (N3): an OS-light first visit has no saved theme, so km.js leaves `data-theme` off
 *  the root. The warm home must still be warm (never near-white), the grade chip and footer links must be AA,
 *  and the whole page must pass axe color-contrast on that path too. */
for (const vp of viewports) {
  test(`home os-light first visit ${vp.name}: warm sheet, AA chip and footer, no saved theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(`${base}/?nomotion=1`);
    await waitFor2dLandscape(page);

    const firstVisit = await page.evaluate(() => ({
      osLight: matchMedia("(prefers-color-scheme: light)").matches,
      savedTheme: localStorage.getItem("km-theme"),
      dataTheme: document.documentElement.getAttribute("data-theme"),
    }));
    expect(firstVisit.osLight, "OS reports a light color scheme").toBe(true);
    expect(firstVisit.savedTheme, "no saved km-theme on a first visit").toBeNull();
    expect(firstVisit.dataTheme, "no data-theme attribute on a first visit").toBeNull();

    const colors = await page.evaluate(() => {
      const toRgb = (css: string) => {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const ctx = c.getContext("2d")!;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!];
      };
      const store = document.querySelector(".km-page-home .km-store")!;
      const row = document.querySelector(".km-page-home .km-result-row")!;
      const footer = document.querySelector(".km-page-home .km-footer")!;
      return {
        store: toRgb(getComputedStyle(store).backgroundColor),
        row: toRgb(getComputedStyle(row).backgroundColor),
        footer: toRgb(getComputedStyle(footer).backgroundColor),
      };
    });

    for (const [name, rgb] of [
      ["store sheet", colors.store],
      ["result row", colors.row],
      ["footer", colors.footer],
    ] as const) {
      const nearWhite = rgb[0] >= 245 && rgb[1] >= 245 && rgb[2] >= 245;
      expect(nearWhite, `${name} background rgb(${rgb.join(",")}) must not be near-white on an OS-light first visit`).toBe(false);
    }

    // The two AA misses in the light-home axe run: the BTC grade chip ink and the footer links.
    const ratios = await page.evaluate(() => {
      const toRgb = (css: string) => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 1;
        const ctx = cv.getContext("2d")!;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!];
      };
      const alphaOf = (css: string) => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 1;
        const ctx = cv.getContext("2d")!;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        return ctx.getImageData(0, 0, 1, 1).data[3]! / 255;
      };
      // Background actually seen behind the text: the nearest ancestor with a mostly-opaque fill.
      const effBg = (el: Element) => {
        let n: Element | null = el;
        while (n) {
          const bg = getComputedStyle(n).backgroundColor;
          if (alphaOf(bg) > 0.5) return toRgb(bg);
          n = n.parentElement;
        }
        return [255, 255, 255];
      };
      const relLum = (rgb: number[]) => {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
      };
      const measure = (el: Element) => {
        const bg = effBg(el);
        const fg = toRgb(getComputedStyle(el).color);
        const l1 = relLum(fg);
        const l2 = relLum(bg);
        return { bg, fg, ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) };
      };
      const chips = Array.from(document.querySelectorAll(".km-page-home .km-grade")).map(measure);
      const footerLinks = Array.from(document.querySelectorAll(".km-page-home .km-footer a")).map(measure);
      const worst = (xs: { bg: number[]; fg: number[]; ratio: number }[]) =>
        xs.length ? xs.reduce((a, b) => (b.ratio < a.ratio ? b : a)) : { bg: [255, 255, 255], fg: [0, 0, 0], ratio: 0 };
      return { chips: chips.length, grade: worst(chips), footerLink: worst(footerLinks) };
    });

    expect(ratios.chips, "the home store list renders BTC grade chips").toBeGreaterThanOrEqual(1);
    expect(
      ratios.grade.ratio,
      `weakest grade chip rgb(${ratios.grade.fg.join(",")}) on rgb(${ratios.grade.bg.join(",")})`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      ratios.footerLink.ratio,
      `weakest footer link rgb(${ratios.footerLink.fg.join(",")}) on rgb(${ratios.footerLink.bg.join(",")})`,
    ).toBeGreaterThanOrEqual(4.5);

    await page.screenshot({
      path: `e2e/artifacts/home-scene-${vp.name}-oslight.png`,
      animations: "disabled",
      fullPage: false,
    });

    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious).toEqual([]);
  });
}

/** GO-KM-HOME-SCENE: result-row name text meets WCAG AA (4.5:1) on its row background, both schemes. */
for (const scheme of schemes) {
  test(`home result row name contrast ${scheme}: AA 4.5:1`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript((s) => localStorage.setItem("km-theme", s as string), scheme);
    await page.goto(`${base}/?nomotion=1`);
    await waitFor2dLandscape(page);

    const c = await page.evaluate(() => {
      const toRgb = (css: string) => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 1;
        const ctx = cv.getContext("2d")!;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0]!, d[1]!, d[2]!];
      };
      const relLum = (rgb: number[]) => {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
      };
      const contrast = (a: number[], b: number[]) => {
        const l1 = relLum(a);
        const l2 = relLum(b);
        const hi = Math.max(l1, l2);
        const lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
      };
      const row = document.querySelector(".km-home-list .km-result-row")!;
      const name = row.querySelector(".km-tag-id a")!;
      const bg = toRgb(getComputedStyle(row).backgroundColor);
      const fg = toRgb(getComputedStyle(name).color);
      return { bg, fg, ratio: contrast(fg, bg) };
    });

    expect(c.ratio, `name text rgb(${c.fg.join(",")}) on row rgb(${c.bg.join(",")})`).toBeGreaterThanOrEqual(4.5);
  });
}
