/** Shipping-rule conditions. A rule that applies only to members, loyalty programs, subscribers, promo codes, first orders,
 * students/military or signed-in accounts never applies to a guest agent, so it must not set a guest's shipping price. */
export const CONDITIONAL_RX = /\b(members?|membership|loyalty|rewards? (program|members?)|soundlab|subscribers?|subscription|prime|club|insiders?|vip|promo(tion(al)?)? codes?|coupon|discount code|use code|first[- ]time|first order|students?|military|account holders?|signed[- ]in|logged[- ]in|when you sign (in|up)|limited[- ]time|for a limited time)\b/i;
export type RuleLike = { type?: string; quote?: string; conditions?: string | null; region?: string | null; min_usd?: number | null };
export function ruleCondition(r: RuleLike): string | null {
  if (r.conditions) return r.conditions;
  const m = (r.quote ?? "").match(CONDITIONAL_RX);
  return m ? `conditional: "${m[0]}"` : null;
}
/** Free-shipping threshold that applies to everyone in the US (unconditional free_over rule), else null. */
export function guestFreeMin(rules: RuleLike[] | undefined): number | null {
  const r = (rules ?? []).find((x) => x.type === "free_over" && (!x.region || x.region === "US" || x.region === "contiguous-US") && typeof x.min_usd === "number" && !ruleCondition(x));
  return r ? r.min_usd! : null;
}
