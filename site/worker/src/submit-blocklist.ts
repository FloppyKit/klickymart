/** Gate blocklist (same shape as crawler/gate_blocklist.json: {domain: reason}). Copied from the box crawler's
 * gate_blocklist.json; refresh this file when that list changes. Submissions of these domains are rejected with the reason. */
export const GATE_BLOCKLIST: Record<string, string> = {
  "wacaco.com": "terms ban automated access (bans-automation, out/v5live/tos.jsonl); incident 2026-10-30, see INCIDENTS.md"
};
