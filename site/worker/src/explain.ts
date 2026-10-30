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

export function checkoutOf(row: IndexRow, raw: Record<string, unknown>) {
  const probe = raw.checkout_probe as { step_reached?: string; n?: string; ts?: number; pm_visible?: string } | undefined;
  return {
    co: row.co, steps: typeof raw.steps === "number" ? raw.steps : null,
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
