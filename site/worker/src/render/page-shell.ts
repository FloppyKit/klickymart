import type { Snapshot } from "../index-mem";
import { computeStoryCounts, landscapeFromSnapshot, parseLandscapeOverride, type StoryCounts } from "../landscape-metrics";

export interface PageShell {
  previewData: boolean;
  landscapeReach: number;
  landscapeBtc: number;
  landscapeTier?: number;
  sceneOnly?: boolean;
  story?: StoryCounts;
}

export function isPreviewDataMode(env: { PREVIEW_DATA?: string }): boolean {
  const v = env.PREVIEW_DATA?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function buildPageShell(snap: Snapshot, env: { PREVIEW_DATA?: string }, url?: URL): PageShell {
  const metrics = landscapeFromSnapshot(snap);
  const override = url
    ? parseLandscapeOverride(url.searchParams.get("reach"), url.searchParams.get("btc"), url.searchParams.get("tier"))
    : {};
  const sceneOnly = url?.searchParams.get("scene") === "1";
  return {
    previewData: isPreviewDataMode(env),
    landscapeReach: override.reach ?? metrics.reach,
    landscapeBtc: override.btc ?? metrics.btc,
    landscapeTier: override.tier,
    sceneOnly,
    story: computeStoryCounts(snap.rows),
  };
}
