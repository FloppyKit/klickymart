import { takeAll } from "./ratelimit";
/** GO D9: on-demand recheck of one indexed store. Re-reads robots.txt (honest UA) and the home page status only.
 * Limits: at most 1 live recheck per domain per 10 minutes (else the cached result plus next_allowed_at) and 60 per hour overall.
 * Only domains already in the index; never follows links, never submits anything. */
export const RECHECK_UA = "FloppyKitMapBot/0.2 Agent/KlickyBot (+https://klickymart.com/bot; bot@klickymart.com)";
export const RECHECK_TOKEN = "floppykitmapbot";
export const PER_DOMAIN_S = 600, GLOBAL_PER_HOUR = 60;

/** Minimal robots.txt evaluation for one path: the group naming our token, else '*'. Longest match wins; Allow wins ties. */
export function robotsAllows(txt: string, token: string, path = "/"): { allows: boolean; line: string | null } {
  const groups: { agents: string[]; rules: [string, string][] }[] = [];
  let cur: { agents: string[]; rules: [string, string][] } | null = null; let lastWasAgent = false;
  for (const l0 of txt.split(/\r?\n/)) {
    const l = l0.replace(/#.*/, "").trim(); if (!l) continue;
    const i = l.indexOf(":"); if (i < 0) continue;
    const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; }
    else { lastWasAgent = false; if (cur && (k === "allow" || k === "disallow")) cur.rules.push([k, v]); }
  }
  const g = groups.find((x) => x.agents.some((a) => a !== "*" && token.includes(a))) ?? groups.find((x) => x.agents.includes("*"));
  if (!g) return { allows: true, line: null };
  let best: [string, string] | null = null;
  for (const r of g.rules) {
    if (!r[1]) continue;
    const rx = new RegExp("^" + r[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (rx.test(path) && (!best || r[1].length > best[1].length || (r[1].length === best[1].length && r[0] === "allow"))) best = r;
  }
  return { allows: !best || best[0] === "allow", line: best ? `${best[0] === "allow" ? "Allow" : "Disallow"}: ${best[1]}` : null };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export async function recheck(db: D1Database, domain: string, now: number, fetcher: Fetcher = fetch) {
  const last = await db.prepare("SELECT * FROM rechecks WHERE domain = ? ORDER BY ts DESC LIMIT 1").bind(domain).first<Record<string, unknown>>();
  const cached = (why: string) => ({ domain, live: false, reason: why, result: last ?? null, next_allowed_at: new Date(((last?.ts as number) ?? now) * 1000 + PER_DOMAIN_S * 1000).toISOString() });
  if (last && now - (last.ts as number) < PER_DOMAIN_S) return cached("rate-limit: 1 recheck per domain per 10 minutes");
  const n = await db.prepare("SELECT COUNT(*) AS n FROM rechecks WHERE ts > ?").bind(now - 3600).first<{ n: number }>();
  if ((n?.n ?? 0) >= GLOBAL_PER_HOUR) return { ...cached("rate-limit: 60 rechecks per hour overall"), next_allowed_at: new Date((now + 300) * 1000).toISOString() };
  // KM-008/KIMI-011: atomic takes so parallel callers cannot all pass the read above.
  try {
    const hit = await takeAll(db, [{ k: `rc:d:${domain}:${Math.floor(now / PER_DOMAIN_S)}`, limit: 1, ttlS: 2 * PER_DOMAIN_S }, { k: `rc:g:${Math.floor(now / 3600)}`, limit: GLOBAL_PER_HOUR, ttlS: 7200 }], now);
    if (hit) return cached(hit.k.startsWith("rc:d") ? "rate-limit: 1 recheck per domain per 10 minutes" : "rate-limit: 60 rechecks per hour overall");
  } catch { /* migration pending: fall back to the read check */ }
  const base = `https://${domain.split(".").length > 2 ? "" : "www."}${domain}`;
  const h = { "User-Agent": RECHECK_UA };
  let rs: number | null = null, allows: boolean | null = null, line: string | null = null, home: number | null = null;
  try {
    const r = await fetcher(`${base}/robots.txt`, { headers: h, redirect: "follow", signal: AbortSignal.timeout(10000) });
    rs = r.status;
    if (r.status === 200) { const a = robotsAllows(await r.text(), RECHECK_TOKEN, "/"); allows = a.allows; line = a.line; }
    else if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 429) allows = true; // no robots file
    else allows = false; // 401/403/429/5xx = disallow (G1)
  } catch { rs = null; allows = false; }
  if (allows) {
    try { const r = await fetcher(`${base}/`, { headers: h, redirect: "follow", signal: AbortSignal.timeout(12000) }); home = r.status; } catch { home = null; }
  }
  const verdict = rs === null ? "error" : !allows ? "agents-not-welcome" : home === 200 ? "reachable" : home === 403 || home === 429 || home === 503 ? "agents-not-welcome" : "error";
  await db.prepare("INSERT INTO rechecks (domain, ts, robots_status, robots_allows, robots_line, home_status, verdict) VALUES (?,?,?,?,?,?,?)")
    .bind(domain, now, rs, allows === null ? null : allows ? 1 : 0, line, home, verdict).run();
  return { domain, live: true, result: { domain, ts: now, checked_at: new Date(now * 1000).toISOString(), robots_status: rs, robots_allows: allows, robots_line: line, home_status: home, verdict },
    next_allowed_at: new Date((now + PER_DOMAIN_S) * 1000).toISOString(), note: "robots.txt and home-page status only; the signed record changes on the next crawl" };
}
