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
  return { pre_pay: s.pre_pay ?? null, ships_us: s.ships_us ?? null, free_min_usd: s.free_min_usd ?? null, ...(s.pre_pay_ev ? { pre_pay_ev: s.pre_pay_ev } : {}), ...(s.ships_us_ev ? { ships_us_ev: s.ships_us_ev } : {}), ...(s.free_min_ev ? { free_min_ev: s.free_min_ev } : {}) };
}

/** One source of truth for the headline store facts; every endpoint (check, alternatives, offers, MCP) uses this. */
export function storeFacts(row: IndexRow) {
  const guest = row.guest === null ? null : row.guest === 1;
  return { checkout: row.co, co: row.co, agent_access: row.ag, guest, btc_grade: row.btc, btc: row.btc };
}
export function checkoutOf(row: IndexRow, raw: Record<string, unknown>) {
  const probe = raw.checkout_probe as { step_reached?: string; n?: string; ts?: number; pm_visible?: string } | undefined;
  return {
    co: row.co, steps: typeof raw.steps === "number" ? raw.steps : ((raw.checkout_map as { steps?: unknown[] } | undefined)?.steps?.length ?? null),
    step_list: ((raw.checkout_map as { steps?: { n: number; stage: string; url?: string | null; action?: string | null; status?: unknown }[] } | undefined)?.steps ?? []).map((x) => ({ n: x.n, stage: x.stage, url: x.url ?? null, action: x.action ?? null, status: x.status ?? null })),
    steps_src: typeof raw.steps === "number" ? "record" : (raw.checkout_map ? "checkout_map (probe)" : null),
    guest: row.guest === null ? null : row.guest === 1,
    guest_source: (raw.guest_src as string | undefined) ?? null,
    guest_evidence: (raw.guest_ev as { url: string; q: string } | undefined) ?? null,
    agent_access: row.ag,
    probe: probe ? { step_reached: probe.step_reached ?? null, stopped_at: probe.pm_visible ?? null, note: probe.n ?? (raw.co_n as string | undefined) ?? null, date: iso(probe.ts) } : null,
    scale: "co: 3 guest reaches payment screen in <=3 pages, 2 guest but more steps or gated by address/phone, 1 account required, 0 bot wall before cart, null not observed",
  };
}

/** One-line plain-English verdict summary an agent can show its user. */
export function verdictSummary(row: IndexRow, raw: Record<string, unknown>): string {
  const ap = agentPolicyOf(raw);
  const w = whyOf(raw);
  if (row.status === "crawled") {
    if (ap) return "Pages are reachable, but the store's terms and known practice restrict agent orders (see agent_ordering).";
    return "Reachable: robots.txt allows our crawler and public pages load.";
  }
  if (w?.msg) return w.msg + (w.retry_date ? ` We re-check after ${w.retry_date}.` : "");
  return row.status;
}

export function checkExtras(row: IndexRow, raw: Record<string, unknown>) {
  const ap = agentPolicyOf(raw);
  return {
    summary: verdictSummary(row, raw),
    reason: whyOf(raw),
    agent_ordering: ap ? { policy: ap.v, summary: ap.summary, evidence: ap.ev, ua_rule: ap.ua_rule ?? null } : null,
    landed_cost: shipOf(raw),
    categories: Array.isArray(raw.category) ? raw.category : null,
    sub: Array.isArray(raw.sub) ? raw.sub : null,
    ...v5Extras(raw),
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
<li>Checkout depth (co): <strong>${e(c.co ?? "unknown")}</strong>${c.steps !== null ? ` · ${e(c.steps)} page(s) to the payment screen` : ""}</li>
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
  "network-error": "network/protocol errors (e.g. HTTP/2 reset) on every retry; not classified as a refusal",
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
