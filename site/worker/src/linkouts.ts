/** M4 S6: static Amazon / Target search link-outs. Flag KM_LINKOUTS (default OFF).
 * Built from the query string only: KlickyMart never fetches amazon.com or target.com (no automated requests, final for
 * M4), shows no price or stock for them, and says a person must place the order. */
const on = (v?: string) => { const s = (v ?? "").trim().toLowerCase(); return s === "1" || s === "true" || s === "on"; };
export const linkoutsEnabled = (env: { KM_LINKOUTS?: string }) => on(env.KM_LINKOUTS);
export const LINKOUT_NOTE = "A person must place this order. KlickyMart does not fetch this site and shows no price or stock for it; the link opens that store's own search.";
export const LINKOUT_HOSTS = ["www.amazon.com", "www.target.com"] as const;
export interface Linkout { store: "amazon.com" | "target.com"; url: string; note: string; person_must_order: true; price: null; stock: null; fetched: false }
export function linkoutsFor(q: string | null | undefined): Linkout[] {
  const t = (q ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!t) return [];
  const e = encodeURIComponent(t);
  const mk = (store: Linkout["store"], url: string): Linkout => ({ store, url, note: LINKOUT_NOTE, person_must_order: true, price: null, stock: null, fetched: false });
  return [mk("amazon.com", `https://www.amazon.com/s?k=${e}`), mk("target.com", `https://www.target.com/s?searchTerm=${e}`)];
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function linkoutsHtml(q: string | null | undefined): string {
  const l = linkoutsFor(q);
  if (!l.length) return "";
  return `<section class="km-linkouts"><h2>Also search elsewhere</h2><p class="km-muted">${esc(LINKOUT_NOTE)}</p><ul>${l.map((x) => `<li><a href="${esc(x.url)}" rel="nofollow noopener noreferrer" target="_blank">Search ${esc(x.store)}</a> (a person must place the order)</li>`).join("")}</ul></section>`;
}
