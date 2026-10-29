export const V1_CATEGORIES = ["shopping"] as const;
export type V1Category = (typeof V1_CATEGORIES)[number];

/** v1 directory is shopping/consumer goods; filter validates the vertical slug. */
export function categoryMatchesRow(category: V1Category, _row: { cat_mask: number; status: string }): boolean {
  if (category === "shopping") return true;
  return false;
}
