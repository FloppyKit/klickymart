/** KM-001 / KM-003: bind payment proofs to the payee.
 * - Store binding: a store that has claimed its listing (NIP-05 `claims` or an active DNS `store_claims` row) can list, in its
 *   own 31420 signed by the claimed key, ["ln_node", <66-hex node pubkey>] and ["zap_pubkey", <64-hex LNURL nostrPubkey>].
 *   A preimage proof only verifies when the BOLT11 node signature recovers one of the store's ln_node keys; a zap proof only
 *   verifies when the 9735 receipt is signed by one of its zap_pubkey keys (NIP-57). Without a binding, a proof is an
 *   unverified claim, however well-formed.
 * - Author binding (tips): a 9735 counts only when signed by the nostrPubkey of the LNURL-pay endpoint behind the zapped
 *   author's lud16 (kind 0), fetched over HTTPS and cached in lnurl_cache. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verifyBolt11, type VerifiedBolt11 } from "./bolt11";
import { verifyNostrEvent } from "./nostr-verify";

type Ev = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
export interface StoreBindings { nodes: Set<string>; zapKeys: Set<string> }
export const NO_BINDINGS: StoreBindings = { nodes: new Set(), zapKeys: new Set() };
const tagv = (tags: string[][], k: string) => tags.find((t) => t[0] === k)?.[1];

/** Keys that have claimed d: NIP-05 claims plus active DNS store_claims (the same set facilitation uses, KIMI-004). */
export async function claimedKeys(db: D1Database | undefined, d: string): Promise<string[]> {
  if (!db) return [];
  const out = new Set<string>();
  try { for (const r of (await db.prepare("SELECT pubkey FROM claims WHERE d = ?").bind(d).all<{ pubkey: string }>()).results ?? []) out.add(r.pubkey); } catch { /* table missing */ }
  try { for (const r of (await db.prepare("SELECT pubkey FROM store_claims WHERE domain = ? AND status = 'active'").bind(d).all<{ pubkey: string }>()).results ?? []) out.add(r.pubkey); } catch { /* table missing */ }
  return [...out];
}

export async function storeBindings(db: D1Database | undefined, d: string | null | undefined): Promise<StoreBindings> {
  if (!db || !d) return NO_BINDINGS;
  const keys = await claimedKeys(db, d);
  const b: StoreBindings = { nodes: new Set(), zapKeys: new Set() };
  for (const pk of keys) {
    try {
      const r = await db.prepare("SELECT raw_json FROM site_records WHERE pubkey = ? AND d = ?").bind(pk, d).first<{ raw_json: string }>();
      const ev = r ? (JSON.parse(r.raw_json) as Ev) : null;
      for (const t of ev?.tags ?? []) {
        if (t[0] === "ln_node" && /^0[23][0-9a-f]{64}$/.test(t[1] ?? "")) b.nodes.add(t[1]!);
        if (t[0] === "zap_pubkey" && /^[0-9a-f]{64}$/.test(t[1] ?? "")) b.zapKeys.add(t[1]!);
      }
    } catch { /* site_records missing */ }
  }
  return b;
}

/** NIP-57 receipt check. ok only when: receipt and embedded 9734 are validly signed, the receipt signer is in `signers`,
 * the bolt11 node signature verifies, its description_hash equals sha256(description), its amount is > 0 and matches the
 * request's amount tag when present. */
export function checkZapReceipt(r: Ev | null | undefined, signers: Set<string> | string | null | undefined):
  { ok: true; inv: VerifiedBolt11; request: Ev } | { ok: false; reason: string } {
  if (!r || r.kind !== 9735 || !verifyNostrEvent(r as never, 9735).ok) return { ok: false, reason: "receipt signature" };
  const allowed = typeof signers === "string" ? new Set([signers]) : signers ?? new Set<string>();
  if (!allowed.has(r.pubkey)) return { ok: false, reason: "receipt not signed by the recipient's LNURL nostrPubkey" };
  const desc = tagv(r.tags, "description"); const b = tagv(r.tags, "bolt11");
  let req: Ev | null = null; try { req = JSON.parse(desc ?? "null") as Ev | null; } catch { req = null; }
  if (!req || req.kind !== 9734 || !verifyNostrEvent(req as never, 9734).ok) return { ok: false, reason: "zap request" };
  const inv = b ? verifyBolt11(b) : null;
  if (!inv) return { ok: false, reason: "bolt11 signature" };
  if (!inv.description_hash || inv.description_hash !== bytesToHex(sha256(new TextEncoder().encode(desc!)))) return { ok: false, reason: "description_hash" };
  if (!((inv.amount_msat ?? 0) > 0)) return { ok: false, reason: "amount" };
  const reqAmt = tagv(req.tags, "amount");
  if (reqAmt && Number(reqAmt) !== inv.amount_msat) return { ok: false, reason: "amount mismatch" };
  return { ok: true, inv, request: req };
}

/** Preimage check: the invoice must be node-signed by a key bound to the store and sha256(preimage) must equal its hash. */
export function checkPreimage(preimageHex: string, bolt11: string | undefined, nodes: Set<string>): boolean {
  if (!/^[0-9a-f]{64}$/i.test(preimageHex) || !bolt11) return false;
  const inv = verifyBolt11(bolt11);
  if (!inv || !nodes.has(inv.payee)) return false;
  const h = bytesToHex(sha256(Uint8Array.from(preimageHex.toLowerCase().match(/../g)!.map((x) => parseInt(x, 16)))));
  return h === inv.payment_hash;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const LNURL_TTL_S = 7 * 86400;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|\[|::1)/i;

/** NIP-57: lud16 name@host -> https://host/.well-known/lnurlp/name -> nostrPubkey (when allowsNostr). Cached in D1. */
export async function lnurlNostrPubkey(db: D1Database | undefined, lud16: string, fetcher: Fetcher = fetch, nowS = Math.floor(Date.now() / 1000)): Promise<string | null> {
  const m = lud16.trim().toLowerCase().match(/^([a-z0-9._+-]{1,64})@([a-z0-9-]+(\.[a-z0-9-]+)+)$/);
  if (!m || PRIVATE.test(m[2]!) || /^\d+(\.\d+){3}$/.test(m[2]!)) return null;
  const key = `${m[1]}@${m[2]}`;
  if (db) {
    try {
      const c = await db.prepare("SELECT nostr_pubkey, checked_at FROM lnurl_cache WHERE lud16 = ?").bind(key).first<{ nostr_pubkey: string | null; checked_at: number }>();
      if (c && nowS - c.checked_at < LNURL_TTL_S) return c.nostr_pubkey;
    } catch { /* migration pending */ }
  }
  let pk: string | null = null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetcher(`https://${m[2]}/.well-known/lnurlp/${encodeURIComponent(m[1]!)}`, { redirect: "manual", signal: ctl.signal, headers: { Accept: "application/json", "User-Agent": "FloppyKitMapBot/0.2 (+https://klickymart.com/bot; bot@klickymart.com; lnurl-nip57)" } });
    clearTimeout(t);
    if (res.ok) {
      const txt = (await res.text()).slice(0, 65536);
      const j = JSON.parse(txt) as { allowsNostr?: boolean; nostrPubkey?: string };
      if (j.allowsNostr === true && typeof j.nostrPubkey === "string" && /^[0-9a-f]{64}$/.test(j.nostrPubkey)) pk = j.nostrPubkey;
    }
  } catch { pk = null; }
  if (db) { try { await db.prepare("INSERT INTO lnurl_cache (lud16, nostr_pubkey, checked_at) VALUES (?,?,?) ON CONFLICT(lud16) DO UPDATE SET nostr_pubkey=excluded.nostr_pubkey, checked_at=excluded.checked_at").bind(key, pk, nowS).run(); } catch { /* */ } }
  return pk;
}

/** lud16 from the newest stored kind-0 profile of a pubkey. */
export async function lud16Of(db: D1Database | undefined, pubkey: string): Promise<string | null> {
  if (!db) return null;
  try {
    const r = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = 0 AND pubkey = ? ORDER BY created_at DESC LIMIT 1").bind(pubkey).first<{ raw_json: string }>();
    if (!r) return null;
    const c = JSON.parse((JSON.parse(r.raw_json) as Ev).content) as { lud16?: unknown };
    return typeof c.lud16 === "string" ? c.lud16 : null;
  } catch { return null; }
}

/** Cached-only lookup (no network) used on read paths. */
export async function cachedZapKey(db: D1Database | undefined, lud16: string | null): Promise<string | null> {
  if (!db || !lud16) return null;
  try { return (await db.prepare("SELECT nostr_pubkey FROM lnurl_cache WHERE lud16 = ?").bind(lud16.trim().toLowerCase()).first<{ nostr_pubkey: string | null }>())?.nostr_pubkey ?? null; } catch { return null; }
}
