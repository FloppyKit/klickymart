import { PROBE_402 } from "./probe-402";
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

const BECH32_CS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(v: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1;
  for (const x of v) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]; }
  return chk >>> 0;
}
/** BN-1: true only for a string with a valid bech32 checksum and an ln(bc|tb|bcrt) human-readable prefix (no length cap: invoices exceed 90 chars). */
export function isBolt11Checksum(inv: unknown): boolean {
  if (typeof inv !== "string" || inv.length < 8) return false;
  if (inv !== inv.toLowerCase() && inv !== inv.toUpperCase()) return false;
  const s = inv.toLowerCase(); const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) return false;
  const hrp = s.slice(0, pos);
  if (!/^ln(bc|tb|bcrt)[0-9]*[munp]?$/.test(hrp)) return false;
  const data: number[] = [];
  for (const c of s.slice(pos + 1)) { const d = BECH32_CS.indexOf(c); if (d < 0) return false; data.push(d); }
  const hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  return bech32Polymod(hx.concat(data)) === 1;
}
/** Pull invoice="..." out of a WWW-Authenticate L402 challenge. */
export function invoiceFromChallenge(ch: string | null | undefined): string | null {
  const m = /invoice\s*=\s*"?([A-Za-z0-9]+)"?/i.exec(ch ?? ""); return m ? m[1] : null;
}
const overlay = new Map<string, AgentNative>();
const PROBE_BY_D = new Map(PROBE_402.map((x) => [x.d, x]));
/** #5/#33: what our own probe says about a listed paid-API rail, and whether a bolt11 invoice comes back without a browser. */
export function railCheck(d: string): { bolt11_no_browser: Record<string, unknown>; listing_flag: { code: string; message: string } | null } | null {
  const a = overlay.get(d); if (!a) return null;
  const pr = PROBE_BY_D.get(d);
  // The signed record's an_402 and our later unsigned probe file (probe-402.ts): use whichever definitive result is newer.
  const def = (x: { result?: string } | null | undefined) => !!x && ["verified-402", "no-402", "unreachable"].includes(String(x.result));
  const usePr = !!pr && def(pr) && (!def(a.an_402) || (pr.ts ?? 0) > (a.an_402?.ts ?? 0));
  const src = usePr ? { result: pr!.result as RailState, proto: pr!.proto, endpoint: pr!.endpoint, http: pr!.http, ts: pr!.ts } : a.an_402 ?? (pr ? { result: pr.result as RailState, proto: pr.proto, endpoint: pr.endpoint, http: pr.http, ts: pr.ts } : null);
  const r = src?.result ?? null, proto = src?.proto ?? null, ep = src?.endpoint ?? pr?.endpoint ?? null, http = src?.http ?? null, ts = src?.ts ?? null;
  const verified = r === "verified-402" && http === 402 && proto === "l402";
  const claimsLn = a.an_cat === "l402" || a.an_rails.some((x) => /^(l402|lightning|ln|ln_invoice_no_browser|bolt11)$/.test(x));
  const invOk = verified && isBolt11Checksum(invoiceFromChallenge(pr?.challenge));
  const checked_at = ts ? new Date(ts * 1000).toISOString() : null;
  const bolt11_no_browser = invOk
    ? { verified: true, endpoint: ep, checked_at, evidence: "one unauthenticated request returned HTTP 402 with WWW-Authenticate L402 and an invoice that passes the bech32 checksum with an ln prefix (not paid, not otherwise decoded)" }
    : verified
    ? { verified: false, claimed: claimsLn, label: "L402 challenge (invoice not verified)", endpoint: ep, checked_at, reason: "HTTP 402 with an L402 header, but the invoice did not pass a bech32 checksum with an lnbc/lntb/lnbcrt prefix (or was missing)" }
    : { verified: false, claimed: claimsLn, reason: !claimsLn ? "no Lightning rail listed" : r === "no-402" ? `listed endpoint answered HTTP ${http ?? "?"} without a 402 challenge` : !ep ? "no public endpoint known to probe" : r === "unreachable" ? "endpoint unreachable when probed" : r === "verified-402" ? `402 challenge is ${proto ?? "not L402"}, not a bolt11 invoice` : `not probed yet${pr?.why ? ` (${pr.why})` : ""}` };
  let listing_flag: { code: string; message: string } | null = null;
  if (a.an_cat === "l402" || a.an_cat === "x402") {
    if (r === "no-402") listing_flag = { code: "no-real-402", message: `Listed as ${a.an_cat.toUpperCase()}, but its listed endpoint answered HTTP ${http ?? "?"} with no payment challenge when we checked. Don't rely on it as a paid API until it is rechecked.` };
    else if (!ep && r !== "verified-402") listing_flag = { code: "no-endpoint", message: `Listed as ${a.an_cat.toUpperCase()}, but no public endpoint is known (none in the directory listing or on its own docs pages), so the rail is unchecked.` };
  }
  return { bolt11_no_browser, listing_flag };
}
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
  const rc = railCheck(d);
  return { agent_native: true, category: a.an_cat, label: a.label, rails: a.an_rails, rails_status: a.an_rails_v, probe_402: a.an_402, agent_api: a.agent_api, source: a.an_src,
    bolt11_no_browser: rc?.bolt11_no_browser ?? null, ...(rc?.listing_flag ? { listing_flag: rc.listing_flag } : {}),
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
