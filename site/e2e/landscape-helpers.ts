import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export function expectLandscapeInViewportCanvas(path: string, minAvgGreen = 15): void {
  expectRoadPixelsInBand(path, 0.08, 0.72, minAvgGreen);
}

export async function waitFor2dLandscape(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __kmLandscapeWebGL?: boolean;
        __kmLandscapeReady?: boolean;
      };
      const canvas = document.getElementById("km-landscape") as HTMLCanvasElement | null;
      if (!canvas || canvas.classList.contains("km-landscape-fallback-hidden")) return false;
      if (w.__kmLandscapeWebGL) return false;
      return w.__kmLandscapeReady === true;
    },
    { timeout: 20_000 },
  );
  await page.waitForTimeout(350);
}

export async function assert2dLandscape(page: Page): Promise<void> {
  await waitFor2dLandscape(page);
  const state = await page.evaluate(() => {
    const canvas = document.getElementById("km-landscape") as HTMLCanvasElement;
    return {
      mode: canvas?.dataset.landscapeMode,
      webgl: (window as unknown as { __kmLandscapeWebGL?: boolean }).__kmLandscapeWebGL,
      active2d: (window as unknown as { __kmLandscape2dActive?: boolean }).__kmLandscape2dActive,
      hidden: canvas?.classList.contains("km-landscape-fallback-hidden"),
    };
  });
  expect(state.webgl).toBeFalsy();
  expect(state.active2d).toBe(true);
  expect(state.hidden).toBe(false);
  expect(state.mode).toBe("2d");
}

export async function waitForWebGLLandscape(page: Page, expectedTier: number): Promise<void> {
  await page.waitForFunction(
    (tier) => {
      const w = window as unknown as {
        __kmLandscapeWebGL?: boolean;
        __kmLandscapeFidelity?: number;
      };
      const glCanvas = document.getElementById("km-landscape-gl") as HTMLCanvasElement | null;
      const fallback = document.getElementById("km-landscape") as HTMLCanvasElement | null;
      if (!glCanvas || glCanvas.hidden) return false;
      if (!w.__kmLandscapeWebGL) return false;
      const gl = glCanvas.getContext("webgl2") || glCanvas.getContext("webgl");
      if (!gl && !(w as { __kmLandscapeGlContext?: WebGLRenderingContext }).__kmLandscapeGlContext) {
        return false;
      }
      const fo = fallback ? parseFloat(getComputedStyle(fallback).opacity) : 1;
      if (fo > 0.08) return false;
      const dt = glCanvas.dataset.tier;
      if (dt == null || Number(dt) !== tier) return false;
      if (glCanvas.dataset.webglActive !== "1") return false;
      if (typeof w.__kmLandscapeFidelity === "number" && Math.abs(w.__kmLandscapeFidelity - tier) > 0.05) {
        return false;
      }
      return true;
    },
    expectedTier,
    { timeout: 25_000 },
  );
  await page.waitForTimeout(600);
  await page.waitForFunction(() => (window as unknown as { __kmLandscapeFrameCount?: number }).__kmLandscapeFrameCount! >= 8, {
    timeout: 15_000,
  });
}

export async function assertWebGLLandscape(page: Page, expectedTier: number): Promise<void> {
  await waitForWebGLLandscape(page, expectedTier);
  const state = await page.evaluate((tier) => {
    const glCanvas = document.getElementById("km-landscape-gl") as HTMLCanvasElement;
    const fallback = document.getElementById("km-landscape") as HTMLCanvasElement;
    return {
      webgl: (window as unknown as { __kmLandscapeWebGL?: boolean }).__kmLandscapeWebGL,
      tier: glCanvas?.dataset.tier,
      webglActive: glCanvas?.dataset.webglActive,
      fallbackOpacity: fallback ? getComputedStyle(fallback).opacity : "1",
      glHidden: glCanvas?.hidden,
      fidelity: (window as unknown as { __kmLandscapeFidelity?: number }).__kmLandscapeFidelity,
    };
  }, expectedTier);
  expect(state.webgl).toBe(true);
  expect(state.glHidden).toBe(false);
  expect(state.webglActive).toBe("1");
  expect(Number(state.tier)).toBe(expectedTier);
  expect(parseFloat(state.fallbackOpacity)).toBeLessThan(0.08);
  if (typeof state.fidelity === "number") {
    expect(state.fidelity).toBeCloseTo(expectedTier, 0);
  }
}

export function pixelDiffRatio(pathA: string, pathB: string): number {
  const a = PNG.sync.read(fs.readFileSync(pathA));
  const b = PNG.sync.read(fs.readFileSync(pathB));
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`PNG size mismatch ${pathA} vs ${pathB}`);
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const mismatched = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.12 });
  return mismatched / (a.width * a.height);
}

export function expectMeaningfulPixelDiff(pathA: string, pathB: string, minRatio = 0.015): void {
  const ratio = pixelDiffRatio(pathA, pathB);
  expect(ratio, `expected pixel diff >= ${minRatio}, got ${ratio}`).toBeGreaterThanOrEqual(minRatio);
}

/** Sample a horizontal band for neon grid / road (green channel). */
export function expectRoadPixelsInBand(
  path: string,
  yStartRatio: number,
  yEndRatio: number,
  minAvgGreen = 28,
): void {
  const p = PNG.sync.read(fs.readFileSync(path));
  const w = p.width;
  const h = p.height;
  let g = 0;
  let n = 0;
  const y0 = Math.floor(h * yStartRatio);
  const y1 = Math.floor(h * yEndRatio);
  for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x += 2) {
    for (let y = y0; y < y1; y += 2) {
      g += p.data[(y * w + x) * 4 + 1];
      n++;
    }
  }
  const avg = g / n;
  expect(avg, `expected road/grid green avg >= ${minAvgGreen}, got ${avg.toFixed(1)}`).toBeGreaterThanOrEqual(
    minAvgGreen,
  );
}

export function expectRoadPixelsInLowerBand(path: string, minAvgGreen = 28): void {
  expectRoadPixelsInBand(path, 0.55, 0.98, minAvgGreen);
}
