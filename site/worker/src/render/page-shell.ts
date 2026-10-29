import type { Snapshot } from "../index-mem";
import { landscapeFromSnapshot, parseLandscapeOverride } from "../landscape-metrics";

export interface PageShell {
  previewData: boolean;
  landscapeReach: number;
  landscapeBtc: number;
}

export function isPreviewDataMode(env: { PREVIEW_DATA?: string }): boolean {
  const v = env.PREVIEW_DATA?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function buildPageShell(snap: Snapshot, env: { PREVIEW_DATA?: string }, url?: URL): PageShell {
  const metrics = landscapeFromSnapshot(snap);
  const override = url ? parseLandscapeOverride(url.searchParams.get("reach"), url.searchParams.get("btc")) : {};
  return {
    previewData: isPreviewDataMode(env),
    landscapeReach: override.reach ?? metrics.reach,
    landscapeBtc: override.btc ?? metrics.btc,
  };
}
