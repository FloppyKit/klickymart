import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

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
