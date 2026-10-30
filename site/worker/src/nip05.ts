/** NIP-05 checks for keys that have posted notes, used only as a public same-operator hint in flags.ts.
 * Mirrors crawler/gate.py: robots.txt first with our honest UA (404 = allowed; 403/5xx/timeout = disallowed), refuse
 * domains our index marks as not-welcome, public hostnames only, no redirects (NIP-05), small timeouts, few per pass. */
export const NIP05_UA = "KlickyMartBot/1.0 (+https://klickymart.com/bot; bot@klickymart.com)";
export const NIP05_LIMITS = { perPass: 10, recheckS: 7 * 86400, timeoutMs: 5000 };
/** Large public NIP-05 providers: many unrelated people share these, so they never give more than a weak flag. */
export const BIG_NIP05_PROVIDERS = new Set(["primal.net", "iris.to", "snort.social", "nostrplebs.com", "nostr.com", "getalby.com", "damus.io", "nostrcheck.me", "zaps.lol",
  "current.fyi", "nostr.band", "habla.news", "coinos.io", "minibits.cash", "npub.cash", "nostr.wine", "stacker.news", "nostriches.net", "bitcoiner.chat", "nos.social", "yakihonne.com", "nostur.com", "highlighter.com", "x.com",
  "strike.me", "fountain.fm", "geyser.fund", "walletofsatoshi.com", "blink.sv", "zbd.gg", "nostrich.house", "lnbits.com"]);
const REFUSE = new Set(["blocked-tos", "agents-not-welcome", "robots-disallowed"]);

export function parseNip05(s: unknown): { name: string; domain: string } | null {
  const m = String(s ?? "").trim().toLowerCase().match(/^([a-z0-9._-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})$/);
  if (!m) return null;
  const domain = m[2]!;
  if (/^(localhost|.*\.local|.*\.internal|.*\.invalid|.*\.test)$/.test(domain)) return null;
  return { name: m[1]!, domain };
}

/** Is `path` allowed for our UA (or *) by this robots.txt? Longest-match Allow/Disallow, as gate.py's robotparser roughly does. */
export function robotsAllows(txt: string, path: string, token = "klickymartbot"): boolean {
  const groups: { agents: string[]; rules: [boolean, string][] }[] = [];
  let cur: { agents: string[]; rules: [boolean, string][] } | null = null; let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); const i = line.indexOf(":"); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (cur && (k === "allow" || k === "disallow") && v) cur.rules.push([k === "allow", v]);
  }
  const g = groups.find((x) => x.agents.some((a) => a !== "*" && token.includes(a))) ?? groups.find((x) => x.agents.includes("*"));
  if (!g) return true;
  let best: [boolean, string] | null = null;
  for (const r of g.rules) { const p = r[1].replace(/\*$/, ""); if (path.startsWith(p) && (!best || p.length > best[1].length || (p.length === best[1].length && r[0]))) best = [r[0], p]; }
  return best ? best[0] : true;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
async function get(f: Fetcher, url: string): Promise<Response | null> {
  try { return await f(url, { headers: { "User-Agent": NIP05_UA, Accept: "application/json, text/plain" }, redirect: "manual", signal: AbortSignal.timeout(NIP05_LIMITS.timeoutMs) }); } catch { return null; }
}

export async function checkNip05(pubkey: string, nip05: unknown, f: Fetcher, indexStatus: (d: string) => string | undefined): Promise<{ status: string; domain: string | null; nip05: string | null }> {
  const p = parseNip05(nip05);
  if (!p) return { status: "none", domain: null, nip05: null };
  const st = indexStatus(p.domain);
  if (st && REFUSE.has(st)) return { status: "gate-refused", domain: p.domain, nip05: `${p.name}@${p.domain}` };
  const base = `https://${p.domain}`;
  const rb = await get(f, `${base}/robots.txt`);
  const robotsOk = rb && rb.status === 404 ? true : rb && rb.status >= 200 && rb.status < 300 ? robotsAllows(await rb.text(), "/.well-known/nostr.json") : false;
  if (!robotsOk) return { status: "robots-disallowed", domain: p.domain, nip05: `${p.name}@${p.domain}` };
  const r = await get(f, `${base}/.well-known/nostr.json?name=${encodeURIComponent(p.name)}`);
  if (!r || r.status !== 200) return { status: "error", domain: p.domain, nip05: `${p.name}@${p.domain}` };
  let j: { names?: Record<string, string> } = {};
  try { j = JSON.parse((await r.text()).slice(0, 200_000)); } catch { return { status: "error", domain: p.domain, nip05: `${p.name}@${p.domain}` }; }
  return { status: j.names?.[p.name]?.toLowerCase() === pubkey ? "verified" : "mismatch", domain: p.domain, nip05: `${p.name}@${p.domain}` };
}

/** One pass: profiles (kind 0) of note authors that are unchecked or stale. Returns how many were checked. */
export async function nip05Pass(db: D1Database, f: Fetcher, indexStatus: (d: string) => string | undefined, nowS = Math.floor(Date.now() / 1000)): Promise<number> {
  try {
    const { results } = await db.prepare(`SELECT e.pubkey, e.raw_json FROM nostr_events e
      JOIN (SELECT pubkey, MAX(created_at) AS c FROM nostr_events WHERE kind = 0 GROUP BY pubkey) l ON l.pubkey = e.pubkey AND l.c = e.created_at AND e.kind = 0
      WHERE e.pubkey IN (SELECT DISTINCT pubkey FROM experiences)
        AND e.pubkey NOT IN (SELECT pubkey FROM nip05_checks WHERE checked_at > ?) LIMIT ?`).bind(nowS - NIP05_LIMITS.recheckS, NIP05_LIMITS.perPass).all<{ pubkey: string; raw_json: string }>();
    for (const r of results ?? []) {
      let prof: { nip05?: unknown } = {}; try { prof = JSON.parse(JSON.parse(r.raw_json).content); } catch { /* */ }
      const c = await checkNip05(r.pubkey, prof.nip05, f, indexStatus);
      await db.prepare("INSERT INTO nip05_checks (pubkey,nip05,domain,status,checked_at) VALUES (?,?,?,?,?) ON CONFLICT(pubkey) DO UPDATE SET nip05=excluded.nip05, domain=excluded.domain, status=excluded.status, checked_at=excluded.checked_at")
        .bind(r.pubkey, c.nip05, c.domain, c.status, nowS).run();
    }
    return results?.length ?? 0;
  } catch { return 0; }
}

export async function verifiedNip05(db: D1Database): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try { const { results } = await db.prepare("SELECT pubkey, domain FROM nip05_checks WHERE status = 'verified'").all<{ pubkey: string; domain: string }>(); for (const r of results ?? []) m.set(r.pubkey, r.domain); } catch { /* */ }
  return m;
}
