import { guestFreeMin, type RuleLike } from "./ship-rules";
/** GO 5.7: explain verdicts (why), agent-ordering policy, checkout depth provenance and landed-cost signals. Pure, from raw records. */
import type { IndexRow } from "./index-mem";

export interface Why { code: string; msg?: string; http?: number; url?: string; robots_line?: string; robots_group?: string; tos_q?: string; tos_url?: string; q?: string; cause?: string; checked?: number; retry?: number }
export interface AgentPolicy { v: string; summary: string; ev: { url: string; kind: string; q: string }[]; ua_rule?: string; checked?: number }
export interface Ship { pre_pay: boolean | null; ships_us: boolean | null; free_min_usd: number | null; pre_pay_ev?: Record<string, unknown>; ships_us_ev?: { url: string; q: string }; free_min_ev?: { url: string; q: string } }

const iso = (t?: number) => (typeof t === "number" ? new Date(t * 1000).toISOString().slice(0, 10) : null);

export function whyOf(raw: Record<string, unknown>): (Why & { checked_date: string | null; retry_date: string | null }) | null {
  const w = raw.why as Why | undefined;
  if (!w || typeof w !== "object") return null;
  return { ...w, checked_date: iso(w.checked), retry_date: iso(w.retry) };
}

export function agentPolicyOf(raw: Record<string, unknown>): AgentPolicy | null {
  const p = raw.agent_policy as AgentPolicy | undefined;
  return p && typeof p === "object" && typeof p.v === "string" ? p : null;
}

export function shipOf(raw: Record<string, unknown>): Ship {
  const s = (raw.ship ?? {}) as Partial<Ship>;
  // One shipping story per store: fall back to the published shipping policy (guest-applicable rules only).
  const pol = raw.ship_policy as { rules?: RuleLike[]; ships_us?: boolean | null } | undefined;
  return { pre_pay: s.pre_pay ?? null, ships_us: s.ships_us ?? pol?.ships_us ?? null, free_min_usd: s.free_min_usd ?? guestFreeMin(pol?.rules), ...(s.pre_pay_ev ? { pre_pay_ev: s.pre_pay_ev } : {}), ...(s.ships_us_ev ? { ships_us_ev: s.ships_us_ev } : {}), ...(s.free_min_ev ? { free_min_ev: s.free_min_ev } : {}) };
}

/** One source of truth for the headline store facts; every endpoint (check, alternatives, offers, MCP) uses this. */
export function storeFacts(row: IndexRow) {
  const guest = row.guest === null ? null : row.guest === 1;
  return { checkout: row.co, co: row.co, agent_access: row.ag, guest, btc_grade: row.btc, btc: row.btc };
}
export function checkoutOf(row: IndexRow, raw: Record<string, unknown>) {
  const probe = raw.checkout_probe as { step_reached?: string; n?: string; ts?: number; pm_visible?: string } | undefined;
  return {
    // steps = stages the checkout probe walked (checkout_map). The record's older numeric `steps` counted crawl pages, not checkout steps.
    co: row.co,
    // steps is always the LIST of stages walked (same shape on every path); steps_count is its length.
    steps_count: (raw.checkout_map as { steps?: unknown[] } | undefined)?.steps?.length ?? null,
    steps: ((raw.checkout_map as { steps?: { n: number; stage: string; url?: string | null; action?: string | null; status?: unknown }[] } | undefined)?.steps ?? []).map((x) => ({ n: x.n, stage: x.stage, url: x.url ?? null, action: x.action ?? null, status: x.status ?? null })),
    steps_src: raw.checkout_map ? "checkout_map (probe)" : null,
    ...(raw.checkout_map ? {} : { steps_note: probe?.step_reached ? `the probe reached "${probe.step_reached}" but no per-step map was recorded for this store yet` : "no checkout probe recorded for this store" }),
    ...networkStaleness(row, raw),
    guest: row.guest === null ? null : row.guest === 1,
    guest_source: (raw.guest_src as string | undefined) ?? null,
    guest_evidence: (raw.guest_ev as { url: string; q: string } | undefined) ?? null,
    agent_access: row.ag,
    probe: probe ? { step_reached: probe.step_reached ?? null, stopped_at: probe.pm_visible ?? null, note: probe.n ?? (raw.co_n as string | undefined) ?? null, date: iso(probe.ts) } : null,
    scale: "co: 3 guest reaches payment screen in <=3 pages, 2 guest but more steps or gated by address/phone, 1 account required, 0 bot wall before cart, null not observed",
  };
}

/**
 * When the newest probe failed with a network error, co is null for that probe only. Expose the last good probe
 * (checkout_map.last_good, carried forward by the crawler) instead of silently dropping it, plus the retry date.
 */
export function networkStaleness(row: IndexRow, raw: Record<string, unknown>) {
  const m = raw.checkout_map as { first_blocker?: { kind?: string; retry_after?: string } | null; checked_at?: string; last_good?: { co?: number | null; stage?: string | null; guest?: boolean | null; checked_at?: string } } | undefined;
  if (!m) return {};
  const lg = m.last_good && typeof m.last_good === "object" ? m.last_good : null;
  const netFail = m.first_blocker?.kind === "network-error";
  if (!netFail && !lg) return {};
  return {
    newest_probe_failed: netFail ? "network-error" : null,
    newest_probe_at: m.checked_at ?? null,
    last_successful_probe: lg?.checked_at ?? null,
    last_good_co: lg?.co ?? null,
    last_good_stage: lg?.stage ?? null,
    retry_after: m.first_blocker?.retry_after ?? null,
    ...(netFail ? { staleness_note: lg ? `newest probe hit network errors; co shown as last_good_co from the last successful probe (${lg.checked_at ?? "date unknown"})` : "newest probe hit network errors and no earlier successful probe is on record; co is unknown (null), not 0. guest may come from a help-page quote, not the probe" } : {}),
  };
}

/** One-line plain-English verdict summary an agent can show its user. */
export function verdictSummary(row: IndexRow, raw: Record<string, unknown>): string {
  const ap = agentPolicyOf(raw);
  const w = whyOf(raw);
  if (row.status === "crawled") {
    if (ap) return "Pages are reachable, but the store's terms and known practice restrict agent orders (see agent_ordering).";
    const fb = checkoutMapOf(raw)?.first_blocker;
    if (fb && CHECKOUT_BLOCKING_KINDS.has(fb.kind)) return `Pages load, but our guest checkout probe was stopped by a ${fb.kind}; checkout is blocked for agents.`;
    return "Reachable: robots.txt allows our crawler and public pages load.";
  }
  if (w?.msg) return w.msg + (w.retry_date ? ` We re-check after ${w.retry_date}.` : "");
  return row.status;
}

/** Probe blockers that mean an agent's guest checkout is actually stopped (pages load, checkout does not). */
export const CHECKOUT_BLOCKING_KINDS = new Set(["bot-wall", "http-refusal"]);
export type CheckVerdict = "reachable" | "checkout-blocked" | "agents-not-welcome" | "blocked-tos" | "error";
/**
 * One derivation for the /check verdict so the verdict never contradicts the blocker or the terms.
 * - crawled + bot-wall/http-refusal first_blocker -> "checkout-blocked" (pages_reachable stays true).
 * - crawled + agent_policy (terms restrict agent orders) -> verdict "reachable" for pages, but primary_reason = terms,
 *   and any probe blocker is marked secondary.
 */
export function deriveVerdict(row: IndexRow, raw: Record<string, unknown>): { verdict: CheckVerdict; pages_reachable: boolean; verdict_reason: string; primary_reason: { source: "terms" | "checkout-probe" | "crawl" | "none"; kind: string; detail: string } } {
  const ap = agentPolicyOf(raw);
  const fb = checkoutMapOf(raw)?.first_blocker ?? null;
  if (row.status !== "crawled") {
    const w = whyOf(raw);
    return { verdict: row.status as CheckVerdict, pages_reachable: false, verdict_reason: w?.msg ?? row.status, primary_reason: { source: row.status === "blocked-tos" ? "terms" : "crawl", kind: row.status, detail: w?.msg ?? row.status } };
  }
  if (ap) {
    return { verdict: "reachable", pages_reachable: true, verdict_reason: `pages load, but the store's terms/known practice restrict agent orders (${ap.v}); that is the primary answer, not the checkout probe`, primary_reason: { source: "terms", kind: ap.v, detail: ap.summary } };
  }
  if (fb && CHECKOUT_BLOCKING_KINDS.has(fb.kind)) {
    return { verdict: "checkout-blocked", pages_reachable: true, verdict_reason: `pages load, but our guest checkout probe hit a ${fb.kind}${fb.url ? ` at ${fb.url}` : ""}; an agent should not expect to check out here`, primary_reason: { source: "checkout-probe", kind: fb.kind, detail: fb.evidence ?? fb.kind } };
  }
  if (fb && fb.kind !== "none") {
    return { verdict: "reachable", pages_reachable: true, verdict_reason: `pages load; the checkout probe stopped at ${fb.kind}, which is not a refusal (checkout depth may be unknown)`, primary_reason: { source: "checkout-probe", kind: fb.kind, detail: fb.evidence ?? fb.kind } };
  }
  return { verdict: "reachable", pages_reachable: true, verdict_reason: fb ? "pages load and the checkout probe found no blocker before the payment screen" : "pages load; no checkout probe recorded", primary_reason: { source: "none", kind: fb ? "none" : "no-probe", detail: "" } };
}

export function checkExtras(row: IndexRow, raw: Record<string, unknown>) {
  const ap = agentPolicyOf(raw);
  const x5 = v5Extras(raw);
  // When the terms are the real answer, mark the probe blocker secondary so it is not read as a clean checkout test.
  const cm = ap && x5.checkout_map?.first_blocker && x5.checkout_map.first_blocker.kind !== "none"
    ? { ...x5.checkout_map, first_blocker: { ...x5.checkout_map.first_blocker, secondary: true, secondary_note: "terms restrict agent orders (see agent_ordering / primary_reason); this probe blocker is secondary, not a clean checkout test" } }
    : x5.checkout_map;
  return {
    summary: verdictSummary(row, raw),
    reason: whyOf(raw),
    agent_ordering: ap ? { policy: ap.v, summary: ap.summary, evidence: ap.ev, ua_rule: ap.ua_rule ?? null } : null,
    landed_cost: shipOf(raw),
    categories: Array.isArray(raw.category) ? raw.category : null,
    sub: Array.isArray(raw.sub) ? raw.sub : null,
    ...x5,
    checkout_map: cm,
  };
}

const e = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const link = (u?: string, t = "Source") => (u ? `<a href="${e(u)}" rel="nofollow noopener">${e(t)}</a>` : "");

export function renderWhy(raw: Record<string, unknown>): string {
  const w = whyOf(raw);
  if (!w) return "";
  const rows: string[] = [];
  if (w.http) rows.push(`<li>HTTP status: <code>${e(w.http)}</code></li>`);
  if (w.robots_line) rows.push(`<li>robots.txt rule: <code>${e(w.robots_group ?? "")}</code> → <code>${e(w.robots_line)}</code> ${link(w.url, "robots.txt")}</li>`);
  if (w.tos_q) rows.push(`<li>Terms clause: <blockquote class="km-quote">${e(w.tos_q)}</blockquote>${link(w.tos_url)}</li>`);
  if (w.q && !w.tos_q) rows.push(`<li>What we saw: <q>${e(w.q)}</q></li>`);
  if (w.cause) rows.push(`<li>Cause: ${e(w.cause)}</li>`);
  if (w.url && !w.robots_line) rows.push(`<li>URL: ${link(w.url, w.url)}</li>`);
  rows.push(`<li>Checked ${e(w.checked_date ?? "unknown")}; next re-check after ${e(w.retry_date ?? "unknown")}</li>`);
  return `<section id="why" data-testid="why"><h2>Why this verdict</h2><p>${e(w.msg ?? w.code)}</p><ul>${rows.join("")}</ul></section>`;
}

export function renderAgentPolicy(raw: Record<string, unknown>): string {
  const ap = agentPolicyOf(raw);
  if (!ap) return "";
  const ev = ap.ev.map((x) => `<li><span class="km-muted">${e(x.kind)}</span> <blockquote class="km-quote">${e(x.q)}</blockquote>${link(x.url)}</li>`).join("");
  return `<section id="agent-ordering" data-testid="agent-ordering"><h2>Agent ordering policy</h2><p><strong>Pages reachable, but terms/known practice restrict agent orders.</strong> ${e(ap.summary)}</p><ul>${ev}</ul>${ap.ua_rule ? `<p>Required agent identification: <code>${e(ap.ua_rule)}</code></p>` : ""}</section>`;
}

const yn = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");
export function renderCheckoutDetail(row: IndexRow, raw: Record<string, unknown>): string {
  const c = checkoutOf(row, raw);
  const s = shipOf(raw);
  const guestEv = c.guest_evidence ? ` — <q>${e(c.guest_evidence.q)}</q> ${link(c.guest_evidence.url)}` : "";
  const probe = c.probe ? `<li>Guest checkout probe (${e(c.probe.date)}): reached <code>${e(c.probe.step_reached)}</code>${c.probe.stopped_at ? `, stopped at <code>${e(c.probe.stopped_at)}</code>` : ""}${c.probe.note ? ` — ${e(c.probe.note)}` : ""}. The probe never submits an order.</li>` : "";
  return `<section id="checkout" data-testid="checkout"><h2>Checkout</h2><ul>
<li>Checkout depth (co): <strong>${e(c.co ?? "unknown")}</strong>${c.steps_count !== null ? ` · ${e(c.steps_count)} step(s) to the payment screen` : ""}</li>
<li>Guest checkout: <strong>${yn(c.guest)}</strong>${c.guest_source ? ` <span class="km-muted">(${e(c.guest_source)})</span>` : ""}${guestEv}</li>
${probe}
<li>Shows shipping and tax before payment: <strong>${yn(s.pre_pay)}</strong></li>
<li>Ships to the US: <strong>${yn(s.ships_us)}</strong>${s.ships_us_ev ? ` — <q>${e(s.ships_us_ev.q)}</q> ${link(s.ships_us_ev.url)}` : ""}</li>
<li>Free-shipping threshold: <strong>${s.free_min_usd === null ? "not stated" : "$" + e(s.free_min_usd)}</strong>${s.free_min_ev ? ` — <q>${e(s.free_min_ev.q)}</q> ${link(s.free_min_ev.url)}` : ""}</li>
</ul><p class="km-muted">${e(c.scale)}. Unknown means not observed, not "no".</p></section>`;
}

/* ---- GO-DATA-V2 (v0.5 records): checkout map, policies, trust, agent-usable payment rails, per-field checked_at ---- */
export interface CheckoutMap { stage: string | null; first_blocker: { kind: string; url?: string | null; evidence?: string | null } | null; steps: { n: number; stage: string; url?: string | null; status?: number | null }[]; checked_at?: string | null; retries?: number }
export function checkoutMapOf(raw: Record<string, unknown>): CheckoutMap | null {
  const m = raw.checkout_map as CheckoutMap | undefined;
  return m && typeof m === "object" ? m : null;
}
export function policiesOf(raw: Record<string, unknown>) {
  const p = raw.policies as Record<string, unknown> | undefined;
  return p && typeof p === "object" ? p : null;
}
export function trustOf(raw: Record<string, unknown>) {
  const t = raw.trust as Record<string, unknown> | undefined;
  return t && typeof t === "object" ? t : null;
}
export function agentpayOf(raw: Record<string, unknown>) {
  return Array.isArray(raw.agentpay) ? (raw.agentpay as Record<string, unknown>[]) : [];
}
export function v5Extras(raw: Record<string, unknown>) {
  return {
    checkout_map: checkoutMapOf(raw),
    agentpay: agentpayOf(raw),
    policies: policiesOf(raw),
    trust: trustOf(raw),
    promos: Array.isArray(raw.promos) ? raw.promos : [],
    ucp: (raw.ucp as Record<string, unknown> | undefined) ?? null,
    offers_observed: typeof raw.offers_n === "number" ? raw.offers_n : null,
    seed_source: (raw.seed_source as string | undefined) ?? null,
    fields_checked_at: (raw.fields_checked as Record<string, string> | undefined) ?? null,
  };
}
const BLOCK_TEXT: Record<string, string> = {
  "bot-wall": "a bot challenge page (Akamai/PerimeterX/Cloudflare/captcha) before the cart; not circumvented",
  "http-refusal": "the store refused our requests (HTTP 403/429) on product or cart pages",
  "network-error": "network/protocol errors (e.g. HTTP/2 reset) on every retry; not classified as a refusal; checkout_depth then carries newest_probe_failed, last_successful_probe, last_good_co and retry_after",
  "no-product-link": "our probe could not find a product link to open",
  "no-add-to-cart": "the product page had no add-to-cart button our probe could use (or the item was out of stock)",
  "login-wall": "checkout requires signing in",
  "robots": "robots.txt disallows the cart or checkout path",
  "oos": "the test item was out of stock",
  "none": "no blocker before the payment screen",
  "form-gate": "the guest checkout form asked for a field the probe does not fill (e.g. phone); not a block",
  "unclassified": "the probe stopped for a reason the rules could not classify",
};
export function renderV5(raw: Record<string, unknown>): string {
  const m = checkoutMapOf(raw), p = policiesOf(raw), t = trustOf(raw), ap = agentpayOf(raw);
  const parts: string[] = [];
  if (m) {
    const steps = m.steps.map((s) => `<li>${e(s.n)}. <code>${e(s.stage)}</code>${s.status ? ` (HTTP ${e(s.status)})` : ""}</li>`).join("");
    const b = m.first_blocker;
    parts.push(`<section id="checkout-map" data-testid="checkout-map"><h2>Checkout map</h2><p>Furthest stage: <strong>${e(m.stage ?? "unknown")}</strong>. First blocker: <strong>${e(b?.kind ?? "unknown")}</strong>${b ? ` — ${e(BLOCK_TEXT[b.kind] ?? "")}` : ""}${b?.evidence ? ` <span class="km-muted">(${e(b.evidence)})</span>` : ""}.</p>${steps ? `<ol class="km-steps">${steps}</ol>` : ""}<p class="km-muted">Checked ${e(m.checked_at ?? "unknown")}. The probe stops at the payment screen and never submits.</p></section>`);
  }
  if (ap.length) parts.push(`<section id="agentpay" data-testid="agentpay"><h2>Payment rails an agent can use</h2><ul>${ap.map((x) => `<li><code>${e(x.rail)}</code> <span class="km-muted">${e(x.scope ?? "")}${x.guest_ok === true ? ", no account needed" : ""}</span>${x.quote ? ` — <q>${e(x.quote)}</q>` : ""} ${link(x.src as string)}</li>`).join("")}</ul></section>`);
  if (p) {
    const q = (p.quotes ?? {}) as Record<string, string>, fs = (p.field_src ?? {}) as Record<string, string>;
    const row = (label: string, k: string, v: unknown) => (v === undefined || v === null ? "" : `<li>${label}: <strong>${e(Array.isArray(v) ? v.join("; ") : v)}</strong>${q[k] ? ` — <q>${e(q[k])}</q>` : ""} ${link(fs[k])}</li>`);
    parts.push(`<section id="policies" data-testid="policies"><h2>Returns and price policies</h2><ul>${row("Return window (days)", "return_days", p.return_days)}${row("Return shipping paid by", "return_ship_payer", p.return_ship_payer)}${row("Price match / adjustment", "price_match", p.price_match)}${row("Price-adjust window (days)", "price_match_window_days", p.price_match_window_days)}${row("Restocking fee (%)", "restocking_pct", p.restocking_pct)}${row("Not returnable", "exclusions", p.exclusions)}</ul><p class="km-muted">Extracted from the store's own policy pages with verbatim quotes, checked ${e(p.checked_at ?? "")}. A missing line means not stated, not "no".</p></section>`);
  }
  const pr = Array.isArray(raw.promos) ? (raw.promos as Record<string, unknown>[]) : [];
  if (pr.length) parts.push(`<section id="promos" data-testid="promos"><h2>Promotions the store advertises</h2><ul>${pr.map((x) => `<li>${x.code ? `<code>${e(x.code)}</code> ` : ""}${e(x.desc)}${x.stacking === "no" ? " <span class=\"km-muted\">(cannot be combined)</span>" : ""} — <q>${e(x.quote)}</q> ${link(x.src as string)}</li>`).join("")}</ul><p class="km-muted">From the store's own pages only; KlickyMart does not test codes at checkout.</p></section>`);
  if (t && t.created) parts.push(`<section id="trust" data-testid="trust"><h2>Trust signals</h2><ul><li>Domain registered: <strong>${e(t.created)}</strong> (${e(t.age_bucket)}) ${link(t.src as string, "RDAP")}</li></ul></section>`);
  return parts.join("\n");
}
