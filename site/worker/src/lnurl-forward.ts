/** zap@klickymart.com: a forwarding Lightning address (t92u). The Worker re-serves the upstream LUD-06 payRequest
 * (LNURL_FORWARD_ZAP, a wrangler var) and proxies its callback, so invoices are created by the upstream wallet and
 * KlickyMart never holds funds. The upstream `metadata` string is passed through VERBATIM: for plain (non-zap)
 * payments the upstream invoice's description_hash commits to that exact string, so rewriting it (e.g. adding a
 * text/identifier "zap@klickymart.com") would make every plain payment fail the payer's hash check. For NIP-57 zaps the
 * description_hash commits to the zap request instead, and allowsNostr/nostrPubkey pass through so 9735 receipts are
 * signed by the upstream zapper key and verify. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { guardedFetch, verifyZapRequest, aCoordPubkey } from "./tip-rails";
import { verifyBolt11 } from "./bolt11";
import { ipHash } from "./submissions";
import { takeAll, give, type Limit } from "./ratelimit";
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
/** R12-004: budget is spent only for a real upstream request and given back when that request fails. Fail closed: a
 * rate-limit store error refuses the request. Returns the refusal, or a refund function to call on upstream failure. */
async function spend(db: D1Database | undefined, kind: "m" | "c", ip: string | null, salt: string): Promise<{ denied: Response } | { refund: () => Promise<void> }> {
  if (!db) return { refund: async () => {} };
  const hr = Math.floor(Date.now() / 3_600_000); const ipH = ipHash(ip, salt);
  const L = kind === "m" ? [FORWARD_LIMITS.metaPerNetPerHour, FORWARD_LIMITS.metaGlobalPerHour] : [FORWARD_LIMITS.cbPerNetPerHour, FORWARD_LIMITS.cbGlobalPerHour];
  const lim: Limit[] = [...(ipH ? [{ k: `lnf:${kind}:ip:${ipH}:${hr}`, limit: L[0], ttlS: 7200 }] : []), { k: `lnf:${kind}:g:${hr}`, limit: L[1], ttlS: 7200 }];
  try { if (await takeAll(db, lim)) return { denied: err("rate limited, try later", 429) }; } catch { return { denied: err("temporary error", 503) }; }
  return { refund: async () => { for (const l of lim) { try { await give(db, l); } catch { /* best effort */ } } } };
}
/** Cached upstream payRequest; a cache hit costs no budget. A miss spends meta budget, refunded if the fetch fails. */
async function upstreamMeta(url: string, o: { fetcher?: F; doh?: F }, db: D1Database | undefined, ip: string | null, salt: string): Promise<UpstreamMeta | Response> {
  const c = cache.get(url); if (c && Date.now() - c.at < FORWARD_LIMITS.cacheTtlMs) return c.meta;
  const b = await spend(db, "m", ip, salt); if ("denied" in b) return b.denied;
  let meta: UpstreamMeta | null = null;
  try { const r = await guardedFetch(url, o); meta = r.ok ? parseMeta(r.text) : null; } catch { meta = null; }
  if (!meta) { await b.refund(); return err("upstream wallet unavailable", 502); }
  cache.set(url, { at: Date.now(), meta });
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
      // R12-001: e/a may only point at KlickyMart's own content; otherwise clients would credit a third party's note
      // with a zap whose sats land in our wallet. a: the coordinate's pubkey must be ours. e: we must hold the event
      // and it must be signed by our key (unknown ids are refused, fail closed).
      const aTag = z.ev.tags.find((t) => t[0] === "a")?.[1];
      if (aTag !== undefined && aCoordPubkey(aTag) !== own) return err("zap request a tag must reference KlickyMart's own content", 403);
      if (z.target) {
        let author: string | null = null;
        try { author = (await env.DB?.prepare("SELECT pubkey FROM nostr_events WHERE id = ?").bind(z.target).first<{ pubkey: string }>())?.pubkey ?? null; } catch { author = null; }
        if (author !== own) return err("zap request e tag must reference a KlickyMart note we hold", 403);
      }
    }
  }
  const meta = await upstreamMeta(up, o, env.DB, ip, salt); if (meta instanceof Response) return meta;
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
  const budget = await spend(env.DB, "c", ip, salt); if ("denied" in budget) return budget.denied;
  const fail = async (reason: string) => { await budget.refund(); return err(reason, 502); };
  let r: Awaited<ReturnType<typeof guardedFetch>>; try { r = await guardedFetch(cb.toString(), o); } catch { return fail("upstream wallet unavailable"); }
  if (!r.ok) return fail("upstream wallet unavailable");
  let inv: { pr?: unknown; reason?: unknown }; try { inv = JSON.parse(r.text); } catch { return fail("upstream returned no JSON"); }
  if (typeof inv.pr !== "string") return fail(typeof inv.reason === "string" ? `upstream: ${inv.reason.slice(0, 200)}` : "upstream returned no invoice");
  const b = verifyBolt11(inv.pr);
  if (!b || b.amount_msat !== amount) return fail("upstream invoice amount mismatch");
  if (b.description_hash !== bytesToHex(sha256(utf8ToBytes(nostr ?? meta.metadata)))) return fail("upstream invoice description_hash mismatch");
  return Response.json({ status: "OK", pr: inv.pr, routes: [] }, { headers: CORS });
}
