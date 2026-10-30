import { markFacilitatedHistory } from "./facilitate";
/** DNS TXT store claims (Path 3, trust_tier verified via "store claim: DNS TXT").
 * Owner: publish TXT at _klickymart.<domain> containing their npub (bare or "klickymart-claim=npub1..."), then POST a kind 1423
 * signed by that key with tags [["r", domain], ["claim", "dns"]]. Revoke with [["claim", "revoke"]] signed by the same key. */
import { verifyNostrEvent } from "./nostr-verify";
import { NOSTR_KIND_STORE_SUGGESTION } from "./nostr-kinds";
import { hexToNpub } from "./claim";
import { normalizeSubmitDomain, clearTierCache } from "./submissions";

export type TxtLookup = (name: string) => Promise<string[] | null>;
/** DNS-over-HTTPS TXT lookup (Cloudflare). null = lookup failed. */
export const dohTxt: TxtLookup = async (name) => {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, { headers: { Accept: "application/dns-json" } });
    if (!r.ok) return null;
    const j = await r.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    if (j.Status !== 0 && j.Status !== 3) return null;
    return (j.Answer ?? []).filter((a) => a.type === 16).map((a) => (a.data.match(/"((?:[^"\\]|\\.)*)"/g) ?? [a.data]).map((x) => x.replace(/^"|"$/g, "")).join(""));
  } catch { return null; }
};
export function txtNames(npub: string, txts: string[]): boolean {
  return txts.some((t) => t.trim().split(/[\s;,]+/).some((w) => w === npub || w === `klickymart-claim=${npub}`));
}

type Res = { status: number; body: Record<string, unknown> };
export async function handleDnsClaim(db: D1Database | undefined, body: Record<string, unknown>, opts: { lookup?: TxtLookup; dryRun?: boolean; now?: number } = {}): Promise<Res> {
  const lookup = opts.lookup ?? dohTxt; const now = opts.now ?? Date.now(); const nowS = Math.floor(now / 1000);
  const bad = (code: string, message: string, status = 400): Res => ({ status, body: { ok: false, error: { code, message } } });
  if (!db) return bad("storage_error", "claims storage not ready", 503);
  // Re-check without an event: re-verify active claims for a domain; TXT gone -> dns-removed.
  if (!body.event) {
    const n = normalizeSubmitDomain(body.domain);
    if (!n.ok) return bad(n.code, n.message);
    const rows = (await db.prepare("SELECT pubkey FROM store_claims WHERE domain = ? AND status = 'active'").bind(n.domain).all<{ pubkey: string }>()).results ?? [];
    const txts = await lookup(`_klickymart.${n.domain}`);
    if (txts === null) return bad("dns_error", "TXT lookup failed; nothing changed", 502);
    const out = [];
    for (const r of rows) {
      const still = txtNames(hexToNpub(r.pubkey), txts);
      if (!opts.dryRun) await db.prepare(still ? "UPDATE store_claims SET checked_at = ? WHERE domain = ? AND pubkey = ?" : "UPDATE store_claims SET status = 'dns-removed', checked_at = ?, revoked_at = ? WHERE domain = ? AND pubkey = ?").bind(...(still ? [nowS, n.domain, r.pubkey] : [nowS, nowS, n.domain, r.pubkey])).run();
      out.push({ npub: hexToNpub(r.pubkey), status: still ? "active" : "dns-removed" });
    }
    if (!opts.dryRun) clearTierCache();
    return { status: 200, body: { ok: true, domain: n.domain, rechecked: out, dry_run: !!opts.dryRun } };
  }
  const ev = body.event as { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string; sig: string };
  if (JSON.stringify(ev).length > 4096) return bad("too_large", "event too large", 413);
  if (/nsec1/i.test(JSON.stringify(body))) return bad("secret_sent", "never send a secret key");
  const v = verifyNostrEvent(ev as never, NOSTR_KIND_STORE_SUGGESTION);
  if (!v.ok) return bad("bad_signature", `${v.reason} (expected a signed kind ${NOSTR_KIND_STORE_SUGGESTION})`);
  if (Math.abs(ev.created_at - nowS) > 86400) return bad("bad_time", "claim events must be created within the last 24 hours");
  const action = ev.tags.find((t) => t[0] === "claim")?.[1];
  if (action !== "dns" && action !== "revoke") return bad("bad_claim", 'needs a ["claim", "dns"] or ["claim", "revoke"] tag');
  const n = normalizeSubmitDomain(ev.tags.find((t) => t[0] === "r")?.[1]);
  if (!n.ok) return bad(n.code, n.message);
  if (n.input_host !== n.domain) return bad("bad_domain", "claim the registrable domain itself (no sub-domain)");
  const pk = ev.pubkey.toLowerCase(); const npub = hexToNpub(pk); const name = `_klickymart.${n.domain}`;
  if (action === "revoke") {
    const cur = await db.prepare("SELECT status FROM store_claims WHERE domain = ? AND pubkey = ?").bind(n.domain, pk).first<{ status: string }>();
    if (!cur) return bad("not_found", "no claim by this key for this domain", 404);
    if (!opts.dryRun) { await db.prepare("UPDATE store_claims SET status = 'revoked', revoked_at = ?, revoke_event_id = ?, checked_at = ? WHERE domain = ? AND pubkey = ?").bind(nowS, ev.id, nowS, n.domain, pk).run(); clearTierCache(); }
    return { status: 200, body: { ok: true, domain: n.domain, npub, status: "revoked", previous: cur.status, dry_run: !!opts.dryRun, stored: !opts.dryRun } };
  }
  const txts = await lookup(name);
  if (txts === null) return bad("dns_error", `TXT lookup for ${name} failed; try again`, 502);
  if (!txtNames(npub, txts)) return { status: 422, body: { ok: false, domain: n.domain, npub, error: { code: "txt_missing", message: `no TXT record at ${name} contains ${npub} (bare or klickymart-claim=${npub})` }, found: txts.slice(0, 5) } };
  if (!opts.dryRun) {
    await db.prepare(`INSERT INTO store_claims (domain,pubkey,method,status,txt,event_id,claimed_at,checked_at) VALUES (?,?,'dns','active',?,?,?,?)
      ON CONFLICT(domain,pubkey) DO UPDATE SET status='active', txt=excluded.txt, event_id=excluded.event_id, checked_at=excluded.checked_at, revoked_at=NULL, revoke_event_id=NULL`).bind(n.domain, pk, txts.join(" | ").slice(0, 500), ev.id, nowS, nowS).run();
    clearTierCache();
    await markFacilitatedHistory(db, n.domain); // KIMI-004: a DNS claim also demotes earlier facilitated 421s
  }
  return { status: dryRunStatus(opts.dryRun), body: { ok: true, domain: n.domain, npub, status: "active", method: "dns", txt_name: name, dry_run: !!opts.dryRun, stored: !opts.dryRun, trust: "trust_tier becomes verified (store claim: DNS TXT)" } };
}
const dryRunStatus = (d?: boolean) => (d ? 200 : 201);

export async function claimStatus(db: D1Database | undefined, domain: string) {
  if (!db) return [];
  try { return ((await db.prepare("SELECT pubkey, status, method, claimed_at, checked_at, revoked_at FROM store_claims WHERE domain = ?").bind(domain).all<Record<string, unknown>>()).results ?? []).map((r) => ({ npub: hexToNpub(String(r.pubkey)), status: r.status, method: r.method, claimed_at: new Date(Number(r.claimed_at) * 1000).toISOString(), checked_at: new Date(Number(r.checked_at) * 1000).toISOString(), revoked_at: r.revoked_at ? new Date(Number(r.revoked_at) * 1000).toISOString() : null })); } catch { return []; }
}
