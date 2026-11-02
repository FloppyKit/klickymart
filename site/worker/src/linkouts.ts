/** M4 S6: static Amazon / Target search link-outs. Flag KM_LINKOUTS (default OFF).
 * Built from the query string only: KlickyMart never fetches amazon.com or target.com (no automated requests, final for
 * M4), shows no price or stock for them, and says a person must place the order. */
const on = (v?: string) => { const s = (v ?? "").trim().toLowerCase(); return s === "1" || s === "true" || s === "on"; };
export const linkoutsEnabled = (env: { KM_LINKOUTS?: string }) => on(env.KM_LINKOUTS);
export const LINKOUT_NOTE = "A person must place this order. KlickyMart does not fetch this site and shows no price or stock for it; the link opens that store's own search.";
export const LINKOUT_HOSTS = ["www.amazon.com", "www.target.com"] as const;
/** Each retailer's own published warning, passed along as static text (never fetched at runtime). Fixed format. */
export interface RetailerNotice { source_url: string; quote: string | null; fetched_at: string | null; note: string }
const OWN_CHOICE = "KlickyMart does not fetch this site. Whether an agent searches or shops it is that agent's own choice, under that site's terms.";
/** Target Terms & Conditions, "Agentic Commerce Tools" / Approved Agents clause, verbatim. Read once by hand
 * (terms/robots only) on 2026-11-01; fetched_at is when that read was saved (/workspace/km-verify/logs/m4-18a31fb7.txt). */
export const TARGET_APPROVED_AGENTS_QUOTE = "The terms in this section apply if you expressly authorize an autonomous agent powered through AI to access and perform certain functions in your Target account on your behalf without continuous human oversight (an “Agentic Commerce Tool”). Only Agentic Commerce Tools provided by Target or by third parties that are expressly approved by you and authorized by Target are permitted to access, navigate, query, or otherwise interact with the Site (each an “Approved Agent” or “Agent”). The current Approved Agents are: Target’s AI Shopping Assistant, OAI, Google and Microsoft. Target may add, remove, or otherwise modify the list of Approved Agents at any time and in its sole discretion.\nAll other Agentic Commerce Tools are unauthorized, expressly prohibited, and may not be used to access, log into, scrape, query, or otherwise interact with or gather data from the Site under any circumstances, whether directly or through API call(s), automated use of user credentials, or other means. Approved Agents cannot be used in combination with other, unapproved Agentic Commerce Tools, unless separately and expressly authorized by Target in writing. Target may implement technical or other controls to limit any Agentic Commerce Tool’s access to, use of, or ability to interact with the Site at any time and in its sole discretion.";
export const RETAILER_NOTICES: Record<"amazon.com" | "target.com", RetailerNotice> = {
  "target.com": { source_url: "https://www.target.com/c/terms-conditions/-/N-4sr7l", quote: TARGET_APPROVED_AGENTS_QUOTE, fetched_at: "2026-11-02T02:08:26Z", note: OWN_CHOICE },
  // Amazon's Conditions of Use returned 403 to us: no quote is invented. (The Associates "Agent/" rule binds only
  // Associates, so it is not presented as Amazon's general rule.)
  "amazon.com": { source_url: "https://www.amazon.com/gp/help/customer/display.html?nodeId=508088", quote: null, fetched_at: null, note: `Terms could not be retrieved; read before shopping. ${OWN_CHOICE}` },
};
export interface Linkout { store: "amazon.com" | "target.com"; url: string; note: string; person_must_order: true; price: null; stock: null; fetched: false; retailer_notice: RetailerNotice }
export function linkoutsFor(q: string | null | undefined): Linkout[] {
  const t = (q ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!t) return [];
  const e = encodeURIComponent(t);
  const mk = (store: Linkout["store"], url: string): Linkout => ({ store, url, note: LINKOUT_NOTE, person_must_order: true, price: null, stock: null, fetched: false, retailer_notice: RETAILER_NOTICES[store] });
  return [mk("amazon.com", `https://www.amazon.com/s?k=${e}`), mk("target.com", `https://www.target.com/s?searchTerm=${e}`)];
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function linkoutsHtml(q: string | null | undefined): string {
  const l = linkoutsFor(q);
  if (!l.length) return "";
  return `<section class="km-linkouts"><h2>Also search elsewhere</h2><p class="km-muted">${esc(LINKOUT_NOTE)}</p><ul>${l.map((x) => `<li><a href="${esc(x.url)}" rel="nofollow noopener noreferrer" target="_blank">Search ${esc(x.store)}</a> (a person must place the order)<br><small>${esc(x.retailer_notice.quote ? `${x.store} terms: “${x.retailer_notice.quote.split("\n")[0]!.slice(0, 280)}…”` : x.retailer_notice.note)} <a href="${esc(x.retailer_notice.source_url)}" rel="nofollow noopener noreferrer">source</a></small></li>`).join("")}</ul></section>`;
}
