/** M4 S7: takedowns. Flag KM_TAKEDOWN (default OFF) gates the public /takedown page + intake contact. Hides recorded in
 * takedown_hides (0025, append-only, written only after a by-hand review) always apply: an event id there is left out
 * of /feed.json, reviews, experience aggregates and community records. Log is hash-only.
 * Repeat offenders: a pubkey with >= 3 valid notices in 365 days has all its events hidden.
 * DMCA designated agent: NOT registered; registration with the U.S. Copyright Office is pending Matt's OK. */
const on = (v?: string) => { const s = (v ?? "").trim().toLowerCase(); return s === "1" || s === "true" || s === "on"; };
export const takedownEnabled = (env: { KM_TAKEDOWN?: string }) => on(env.KM_TAKEDOWN);
export const TAKEDOWN_CONTACT = "bot@klickymart.com";
export const REPEAT_RULE = { notices: 3, windowS: 365 * 86400 } as const;
export const AGENT_STATUS = "pending: the DMCA designated agent is not yet registered with the U.S. Copyright Office (awaiting the owner's OK)";

/** SQL condition (no binds) that is true for rows that are NOT taken down. `t` = table alias or name with id/pubkey columns. */
/** Hides still in force: a hide row with no restore row for the same (event, notice). */
export const ACTIVE_HIDES = "SELECT h.event_id FROM takedown_hides h WHERE NOT EXISTS (SELECT 1 FROM takedown_restores r WHERE r.event_id = h.event_id AND r.notice_hash = h.notice_hash)";
/** Notices that count toward the repeat-offender rule: valid, within the window, and not reversed by a counter-notice restore. */
export const COUNTED_NOTICES = (since: string) => `SELECT notice_hash, pubkey FROM takedown_notices WHERE valid = 1 AND received_at > ${since} AND notice_hash NOT IN (SELECT notice_hash FROM takedown_restores)`;
/** SQL condition (no binds) that is true for rows that are NOT taken down. `t` = table alias or name with id/pubkey columns.
 * Used by every public reader AND every internal scoring reader (flags, tips, key age, trust, submissions). */
export function visibleSql(t: string): string {
  return `${t}.id NOT IN (${ACTIVE_HIDES}) AND ${t}.pubkey NOT IN (SELECT pubkey FROM (${COUNTED_NOTICES(`unixepoch() - ${REPEAT_RULE.windowS}`)}) GROUP BY pubkey HAVING COUNT(*) >= ${REPEAT_RULE.notices})`;
}

export async function isRepeatOffender(db: D1Database, pubkey: string, nowS: number): Promise<boolean> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM (${COUNTED_NOTICES("?")}) WHERE pubkey = ?`).bind(nowS - REPEAT_RULE.windowS, pubkey).first<{ n: number }>();
  return (r?.n ?? 0) >= REPEAT_RULE.notices;
}

export const takedownInfo = () => ({
  contact: TAKEDOWN_CONTACT,
  designated_agent: AGENT_STATUS,
  send: ["the exact event id(s) or KlickyMart URL(s)", "what work or right you say is infringed, and how", "your name and contact details", "a good-faith statement that the use is not authorized", "a statement that the notice is accurate, and (for copyright) under penalty of perjury that you are authorized to act", "your physical or electronic signature"],
  what_we_do: "A person reviews each notice by hand. If it is valid, the event id is hidden on KlickyMart's feed and relay output, index and site. Nostr events are signed by their authors and live on other relays too; we can only stop showing them here.",
  repeat_offender: `A key with ${REPEAT_RULE.notices} valid notices within 365 days has all of its events hidden here.`,
  log: "We keep only hashes of notices and claimant emails, the targeted public key, the decision and dates.",
  counter_notice: `If your event was hidden by mistake, email ${TAKEDOWN_CONTACT} with the event id and why. A person reviews it; if accepted, a restore record (hash-only, never a deletion) makes the event visible again and that notice stops counting toward the repeat-offender rule.`,
});
