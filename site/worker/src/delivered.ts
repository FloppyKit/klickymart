/** M4 S5: delivered price = item price + shipping to the ZIP + estimated tax, from landed.ts. Flag KM_DELIVERED_PRICE
 * (default OFF). Shipping comes only from the store's own published policy / structured data / quotes; when it can't
 * be determined the delivered price is null with "shipping unknown" (never guessed). */
import type { ShipPolicy, ShipRule } from "./landed";

const on = (v?: string) => { const s = (v ?? "").trim().toLowerCase(); return s === "1" || s === "true" || s === "on"; };
export const deliveredPriceEnabled = (env: { KM_DELIVERED_PRICE?: string }) => on(env.KM_DELIVERED_PRICE);

const TYPES = new Set(["free", "free_over", "flat", "per_region", "calculated"]);
/** Validate rules from ship_policy_obs: known types, numeric prices where needed, a quote on every rule. Bad rule -> dropped. */
export function cleanRules(x: unknown): ShipRule[] {
  if (!Array.isArray(x)) return [];
  return x.filter((r): r is ShipRule => !!r && typeof r === "object" && TYPES.has((r as ShipRule).type) && typeof (r as ShipRule).quote === "string" && !!(r as ShipRule).quote!.trim()
    && ((r as ShipRule).type !== "free_over" || (typeof (r as ShipRule).min_usd === "number" && (r as ShipRule).min_usd! >= 0))
    && (!["flat", "per_region"].includes((r as ShipRule).type) || (typeof (r as ShipRule).usd === "number" && (r as ShipRule).usd! >= 0)));
}

let cache: { at: number; map: Map<string, ShipPolicy> } | null = null;
export const SHIP_CACHE_S = 3600;
export function resetShipCache() { cache = null; }
/** Latest observed policy per domain (one aggregate read per isolate per hour). null when the flag is off. */
export async function loadShipPolicies(env: { DB?: D1Database; KM_DELIVERED_PRICE?: string }, nowS: number): Promise<Map<string, ShipPolicy> | null> {
  if (!deliveredPriceEnabled(env) || !env.DB) return null;
  if (cache && nowS - cache.at < SHIP_CACHE_S) return cache.map;
  const map = new Map<string, ShipPolicy>();
  try {
    const rows = (await env.DB.prepare("SELECT o.domain, o.rules_json, o.ships_us, o.src, o.checked_at FROM ship_policy_obs o JOIN (SELECT domain, MAX(checked_at) AS m FROM ship_policy_obs GROUP BY domain) l ON l.domain = o.domain AND l.m = o.checked_at").all<{ domain: string; rules_json: string; ships_us: number | null; src: string | null; checked_at: number }>()).results ?? [];
    for (const r of rows) {
      let rules: ShipRule[] = []; try { rules = cleanRules(JSON.parse(r.rules_json)); } catch { /* */ }
      if (rules.length) map.set(r.domain, { rules, src: r.src, checked_at: new Date(r.checked_at * 1000).toISOString(), ships_us: r.ships_us === null ? null : r.ships_us === 1 });
    }
  } catch { /* table missing */ }
  cache = { at: nowS, map };
  return map;
}

/** Add the observed policy to a record's raw data only when the record has none of its own. */
export function withPolicy(raw: Record<string, unknown>, domain: string, policies: Map<string, ShipPolicy> | null): Record<string, unknown> {
  if (!policies || (raw.ship_policy as ShipPolicy | undefined)?.rules?.length) return raw;
  const p = policies.get(domain.replace(/^www\./, ""));
  return p ? { ...raw, ship_policy: p } : raw;
}

/** The delivered-price field for one row, from its landed block. */
export function deliveredField(landed: Record<string, unknown> | undefined, zip: string | null | undefined) {
  if (!zip || !landed) return { usd: null, zip: zip ?? null, label: "shipping unknown", note: zip ? "no landed cost for this row" : "give zip= for a delivered price" };
  const sh = landed.shipping as { usd: number | null; label?: string } | undefined;
  const total = landed.est_total as number | null | undefined;
  if (!sh || sh.usd === null) return { usd: null, zip, label: "shipping unknown", note: "the store's public shipping policy does not determine shipping to this ZIP; we do not guess" };
  return { usd: typeof total === "number" ? total : null, zip, label: sh.label ?? "policy-derived", parts: { price: landed.item_price ?? null, shipping: sh.usd, tax: landed.est_tax ?? null }, ...(typeof total === "number" ? {} : { note: "tax unknown" }) };
}
