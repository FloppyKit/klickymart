/** Agent-native stores (2026-10-30): L402/x402 paid APIs, VPN, eSIM, VPS, gift cards, nostr-native, agent-commerce.
 * Source: data/events.agent-native.ndjson (signed kind 31420, built in nostr-market/crawler). For domains already in the
 * main index the signed main record is kept and only the agent-native fields are overlaid (never re-written into its content).
 * `an_rails` are rails a directory claims; `an_402` is our own single unauthenticated probe (never paid). */
export type RailState = "verified-402" | "no-402" | "unreachable" | "claimed";
export interface AgentNative {
  an_cat: string;
  an_rails: string[];
  an_rails_v: Record<string, RailState>;
  an_402: { result: RailState; proto: string | null; endpoint: string | null; http: number | null; price_seen: Record<string, unknown> | null; ts: number | null } | null;
  agent_api: Record<string, unknown> | null;
  an_src: string | null;
  label: "verified-402" | "claimed";
}
/** /alternatives (and /q category=) names -> an_cat values. */
export const AN_ALT_CATEGORIES: Record<string, string[]> = {
  vps: ["vps-hosting"], vpn: ["vpn"], esim: ["esim"], "paid-api": ["l402", "x402"], "gift-cards": ["gift-cards"],
};
export const AN_CATS = ["l402", "x402", "vpn", "esim", "vps-hosting", "gift-cards", "nostr-native", "agent-commerce", "btcmap-online"];

const overlay = new Map<string, AgentNative>();
export function clearAgentNative(): void { overlay.clear(); }
export function anOf(d: string): AgentNative | null { return overlay.get(d) ?? null; }
export function anCount(): number { return overlay.size; }

export function fromRaw(raw: Record<string, unknown>): AgentNative | null {
  if (raw.agent_native !== true || typeof raw.an_cat !== "string") return null;
  const rails = Array.isArray(raw.an_rails) ? (raw.an_rails as string[]).filter((x) => typeof x === "string") : [];
  const rv = (raw.an_rails_v && typeof raw.an_rails_v === "object" ? raw.an_rails_v : {}) as Record<string, RailState>;
  const railsV: Record<string, RailState> = {};
  for (const r of rails) railsV[r] = rv[r] ?? "claimed";
  const p = raw.an_402 as Record<string, unknown> | null | undefined;
  const an402 = p && typeof p === "object" ? {
    result: (p.result as RailState) ?? "claimed", proto: (p.proto as string) ?? null, endpoint: (p.endpoint as string) ?? null,
    http: typeof p.http === "number" ? p.http : null, price_seen: (p.price_seen as Record<string, unknown>) ?? null, ts: typeof p.ts === "number" ? p.ts : null,
  } : null;
  return { an_cat: raw.an_cat, an_rails: rails, an_rails_v: railsV, an_402: an402,
    agent_api: (raw.agent_api as Record<string, unknown>) ?? null, an_src: typeof raw.an_src === "string" ? raw.an_src : null,
    label: an402?.result === "verified-402" ? "verified-402" : "claimed" };
}
export function registerAgentNative(d: string, raw: Record<string, unknown>): void {
  const a = fromRaw(raw); if (a) overlay.set(d, a);
}
/** Extra coarse categories an agent-native store belongs to. */
export function anCategories(d: string): string[] {
  const a = overlay.get(d); if (!a) return [];
  return Object.entries(AN_ALT_CATEGORIES).filter(([, v]) => v.includes(a.an_cat)).map(([k]) => k);
}
/** JSON block for API responses. */
export function anJson(d: string): Record<string, unknown> | null {
  const a = overlay.get(d); if (!a) return null;
  return { agent_native: true, category: a.an_cat, label: a.label, rails: a.an_rails, rails_status: a.an_rails_v, probe_402: a.an_402, agent_api: a.agent_api, source: a.an_src,
    note: "rails_status: verified-402 = our one unauthenticated request got a real HTTP 402 with the expected challenge (price_seen is what it asked; we never paid); no-402 = it did not; claimed = listed by a directory, not checked by us." };
}
export function anBadgeHtml(d: string): string {
  const a = overlay.get(d); if (!a) return "";
  const lab = a.label === "verified-402" ? "verified 402" : "claimed";
  return `<span class="badge an" title="Agent-native store (${a.an_cat})">agent-native</span> <span class="badge an-${a.label}" title="${a.label === "verified-402" ? "We saw a real HTTP 402 payment challenge (not paid)" : "Rails listed by a directory, not verified by us"}">${lab}</span>`;
}

import type { RecordRow } from "./normalize";
/** Merge agent-native rows into the main index: new domains are added as their own signed rows; domains already in the
 * index keep their main signed row and get only the agent-native overlay. Returns counts. */
export function mergeAgentNative(main: Map<string, RecordRow>, an: Map<string, RecordRow>): { added: number; overlaid: number } {
  let added = 0, overlaid = 0;
  for (const [d, row] of an) {
    const raw = JSON.parse(row.raw_json) as Record<string, unknown>;
    registerAgentNative(d, raw);
    if (main.has(d)) overlaid++;
    else { main.set(d, row); added++; }
  }
  return { added, overlaid };
}

const escH = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Merchant-page block: rails with verified-402 vs claimed labels and the price the 402 asked for. */
export function anSectionHtml(d: string): string {
  const a = overlay.get(d); if (!a) return "";
  const rails = a.an_rails.map((r) => `<li><code>${escH(r)}</code>: <span class="badge an-${escH(a.an_rails_v[r] ?? "claimed")}">${escH(a.an_rails_v[r] ?? "claimed")}</span></li>`).join("");
  const p = a.an_402;
  const ps = p?.price_seen as { amount?: unknown; asset?: unknown; network?: unknown; usd?: unknown } | null | undefined;
  const probe = p ? `<p>Our probe (one unauthenticated request, never paid): <code>${escH(String(p.endpoint ?? ""))}</code> answered HTTP ${escH(String(p.http ?? "?"))} → <strong>${escH(p.result)}</strong>${ps ? `. Price seen: ${escH(String(ps.amount))} ${escH(String(ps.asset))}${ps.network ? ` on ${escH(String(ps.network))}` : ""}${typeof ps.usd === "number" ? ` (= $${ps.usd})` : ""}` : ""}.</p>` : "";
  return `<section class="km-an" data-testid="agent-native"><h2>Agent-native (${escH(a.an_cat)})</h2><p class="km-muted">Rails listed by <a href="${escH(a.an_src ?? "#")}" rel="nofollow noopener">a directory</a>. verified-402 = we saw a real HTTP 402 payment challenge; claimed = not checked by us.</p><ul>${rails}</ul>${probe}</section>`;
}
