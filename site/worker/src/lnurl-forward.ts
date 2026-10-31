/** zap@klickymart.com: a forwarding Lightning address (t92u). The Worker re-serves the upstream LUD-06 payRequest
 * (LNURL_FORWARD_ZAP, a wrangler var) and proxies its callback, so invoices are created by the upstream wallet and
 * KlickyMart never holds funds. The upstream `metadata` string is passed through VERBATIM: for plain (non-zap)
 * payments the upstream invoice's description_hash commits to that exact string, so rewriting it (e.g. adding a
 * text/identifier "zap@klickymart.com") would make every plain payment fail the payer's hash check. For NIP-57 zaps the
 * description_hash commits to the zap request instead, and allowsNostr/nostrPubkey pass through so 9735 receipts are
 * signed by the upstream zapper key and verify. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { guardedFetch, verifyZapRequest } from "./tip-rails";
import { verifyBolt11 } from "./bolt11";
import { ipHash } from "./submissions";
import { takeAll, type Limit } from "./ratelimit";
import { publicHost } from "./nostr-app";

type F = (url: string, init?: RequestInit) => Promise<Response>;
export const FORWARD_NAMES = ["zap"] as const;
export const FORWARD_LIMITS = { metaPerNetPerHour: 240, metaGlobalPerHour: 6000, cbPerNetPerHour: 60, cbGlobalPerHour: 1200, cacheTtlMs: 60_000 };
export interface UpstreamMeta { callback: string; metadata: string; minSendable: number; maxSendable: number; commentAllowed?: number; allowsNostr?: boolean; nostrPubkey?: string }
const cache = new Map<string, { at: number; meta: UpstreamMeta }>();
export const resetForwardCache = () => cache.clear();
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Cache-Control": "no-store" };
const err = (reason: string, status = 400) => Response.json({ status: "ERROR", reason }, { status, headers: CORS });

export function upstreamUrl(v: string | undefined): string | null {
  // Keep the name's case (primal.net serves /.well-known/lnurlp/DrMattBrown); only the domain is case-insensitive.
  const m = /^([A-Za-z0-9._+-]{1,64})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/.exec((v ?? "").trim());
  return m && publicHost(m[2].toLowerCase()) ? `https://${m[2].toLowerCase()}/.well-known/lnurlp/${m[1]}` : null;
}
function parseMeta(text: string): UpstreamMeta | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j.tag !== "payRequest" || typeof j.callback !== "string" || !j.callback.startsWith("https://") || typeof j.metadata !== "string") return null;
    if (typeof j.minSendable !== "number" || typeof j.maxSendable !== "number" || j.minSendable < 1 || j.maxSendable < j.minSendable) return null;
    JSON.parse(j.metadata);
    const nostr = j.allowsNostr === true && typeof j.nostrPubkey === "string" && /^[0-9a-f]{64}$/.test(j.nostrPubkey);
    return { callback: j.callback, metadata: j.metadata, minSendable: j.minSendable, maxSendable: j.maxSendable, commentAllowed: typeof j.commentAllowed === "number" ? Math.max(0, Math.min(2000, j.commentAllowed)) : undefined,
      ...(nostr ? { allowsNostr: true, nostrPubkey: j.nostrPubkey as string } : {}) };
  } catch { return null; }
}
async function limited(db: D1Database | undefined, kind: "m" | "c", ip: string | null, salt: string): Promise<Response | null> {
  if (!db) return null;
  const hr = Math.floor(Date.now() / 3_600_000); const ipH = ipHash(ip, salt);
  const L = kind === "m" ? [FORWARD_LIMITS.metaPerNetPerHour, FORWARD_LIMITS.metaGlobalPerHour] : [FORWARD_LIMITS.cbPerNetPerHour, FORWARD_LIMITS.cbGlobalPerHour];
  const lim: Limit[] = [...(ipH ? [{ k: `lnf:${kind}:ip:${ipH}:${hr}`, limit: L[0], ttlS: 7200 }] : []), { k: `lnf:${kind}:g:${hr}`, limit: L[1], ttlS: 7200 }];
  try { return (await takeAll(db, lim)) ? err("rate limited, try later", 429) : null; } catch { return err("temporary error", 503); }
}
async function upstreamMeta(url: string, o: { fetcher?: F; doh?: F }): Promise<UpstreamMeta | null> {
  const c = cache.get(url); if (c && Date.now() - c.at < FORWARD_LIMITS.cacheTtlMs) return c.meta;
  const r = await guardedFetch(url, o); if (!r.ok) return null;
  const meta = parseMeta(r.text); if (meta) cache.set(url, { at: Date.now(), meta });
  return meta;
}

/** GET /.well-known/lnurlp/<name> and GET /.well-known/lnurlp/<name>/callback. Returns null for other paths. */
export async function handleLnurlForward(path: string, url: URL, env: { DB?: D1Database; LNURL_FORWARD_ZAP?: string; SUBMIT_SALT?: string; SITE_ZAP_PUBKEY_HEX?: string }, origin: string, ip: string | null, salt: string, o: { fetcher?: F; doh?: F } = {}): Promise<Response | null> {
  const m = /^\/\.well-known\/lnurlp\/([^/]+)(\/callback)?$/.exec(path); if (!m) return null;
  const name = m[1].toLowerCase(); const up = name === "zap" ? upstreamUrl(env.LNURL_FORWARD_ZAP) : null;
  if (!up) return err("unknown lightning address", 404);
  // R9-002: validate the caller's input BEFORE taking rate-limit budget (meta-dependent bounds are checked after).
  const amount = Number(url.searchParams.get("amount"));
  const nostr = m[2] ? url.searchParams.get("nostr") : null; const comment = m[2] ? url.searchParams.get("comment") : null;
  if (m[2]) {
    if (!Number.isInteger(amount) || amount < 1) return err("amount must be a positive integer (msat)");
    if (comment !== null && comment.length > 2000) return err("comment too long");
    if (nostr !== null) {
      // R9-001: a zap request routed through zap@klickymart.com must zap KlickyMart itself. Otherwise sats land in our
      // wallet while clients credit the pubkey named in the p tag. Fail closed when our zap pubkey is not configured.
      const own = (env.SITE_ZAP_PUBKEY_HEX ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(own)) return err("zaps are not enabled for this address (SITE_ZAP_PUBKEY_HEX unset); plain payments still work", 403);
      let ev: unknown; try { ev = JSON.parse(nostr); } catch { return err("nostr must be a JSON zap request"); }
      const z = verifyZapRequest(ev); if (!z.ok) return err(z.message); // kind 9734, signature, exactly one p tag, amount tag
      if (z.recipient.toLowerCase() !== own) return err("zap request p tag must be KlickyMart's own pubkey; this address does not forward zaps for other recipients", 403);
      if (z.amount !== amount) return err("zap request amount differs from amount");
    }
  }
  const lim = await limited(env.DB, m[2] ? "c" : "m", ip, salt); if (lim) return lim;
  const meta = await upstreamMeta(up, o); if (!meta) return err("upstream wallet unavailable", 502);
  if (!m[2]) {
    return Response.json({ status: "OK", tag: "payRequest", callback: `${origin}/.well-known/lnurlp/${name}/callback`, metadata: meta.metadata, minSendable: meta.minSendable, maxSendable: meta.maxSendable,
      ...(meta.commentAllowed !== undefined ? { commentAllowed: meta.commentAllowed } : {}), ...(meta.allowsNostr && /^[0-9a-f]{64}$/.test((env.SITE_ZAP_PUBKEY_HEX ?? "").trim().toLowerCase()) ? { allowsNostr: true, nostrPubkey: meta.nostrPubkey } : {}) }, { headers: { ...CORS, "Cache-Control": "public, max-age=60" } });
  }
  if (amount < meta.minSendable || amount > meta.maxSendable) return err(`amount must be an integer from ${meta.minSendable} to ${meta.maxSendable} msat`);
  if (nostr !== null && !meta.allowsNostr) return err("zaps not supported by the upstream wallet");
  if (comment !== null && comment.length > (meta.commentAllowed ?? 0)) return err("comment too long");
  const cb = new URL(meta.callback); cb.searchParams.set("amount", String(amount));
  if (nostr !== null) cb.searchParams.set("nostr", nostr);
  if (comment) cb.searchParams.set("comment", comment);
  const lnurl = url.searchParams.get("lnurl"); if (lnurl && /^lnurl1[02-9ac-hj-np-z]+$/i.test(lnurl)) cb.searchParams.set("lnurl", lnurl);
  const r = await guardedFetch(cb.toString(), o); if (!r.ok) return err("upstream wallet unavailable", 502);
  let inv: { pr?: unknown; reason?: unknown }; try { inv = JSON.parse(r.text); } catch { return err("upstream returned no JSON", 502); }
  if (typeof inv.pr !== "string") return err(typeof inv.reason === "string" ? `upstream: ${inv.reason.slice(0, 200)}` : "upstream returned no invoice", 502);
  const b = verifyBolt11(inv.pr);
  if (!b || b.amount_msat !== amount) return err("upstream invoice amount mismatch", 502);
  if (b.description_hash !== bytesToHex(sha256(utf8ToBytes(nostr ?? meta.metadata)))) return err("upstream invoice description_hash mismatch", 502);
  return Response.json({ status: "OK", pr: inv.pr, routes: [] }, { headers: CORS });
}
