/** zap@klickymart.com: a forwarding Lightning address (t92u). The Worker re-serves the upstream LUD-06 payRequest
 * (LNURL_FORWARD_ZAP, a wrangler var) and proxies its callback, so invoices are created by the upstream wallet and
 * KlickyMart never holds funds. The upstream `metadata` string is passed through VERBATIM: for plain (non-zap)
 * payments the upstream invoice's description_hash commits to that exact string, so rewriting it (e.g. adding a
 * text/identifier "zap@klickymart.com") would make every plain payment fail the payer's hash check. For NIP-57 zaps the
 * description_hash commits to the zap request instead, and allowsNostr/nostrPubkey pass through so 9735 receipts are
 * signed by the upstream zapper key and verify. */
import { guardedFetch, verifyZapRequest, aCoordPubkey } from "./tip-rails";
import { verifyBolt11 } from "./bolt11";
import { ipHash } from "./submissions";
import { take, takeAll, give, type Limit } from "./ratelimit";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { publicHost } from "./nostr-app";

type F = (url: string, init?: RequestInit) => Promise<Response>;
export const FORWARD_NAMES = ["zap"] as const;
export const FORWARD_LIMITS = { metaPerNetPerHour: 240, metaGlobalPerHour: 6000, cbPerNetPerHour: 60, cbGlobalPerHour: 1200, cacheTtlMs: 60_000, failPerNetPerHour: 20, failGlobalPerHour: 300, replayTtlS: 86_400 };
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
function parseMeta(text: string, upHost?: string): UpstreamMeta | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j.tag !== "payRequest" || typeof j.callback !== "string" || !j.callback.startsWith("https://") || typeof j.metadata !== "string") return null;
    // R9-003: the callback must stay on the configured upstream's host (or a subdomain of it).
    if (upHost) { let h = ""; try { const cu = new URL(j.callback); if (cu.port || cu.username || cu.password) return null; h = cu.hostname.toLowerCase(); } catch { return null; } if (h !== upHost && !h.endsWith(`.${upHost}`)) return null; }
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
/** GP-3: rate-limit network for the failure budget: IPv4 /24, IPv6 /48 (coarser than ipHash's /32 and /64). */
export function failNet(ip: string | null): string | null {
  if (!ip) return null; const v = ip.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v); if (v4) return `4:${v4[1]}.${v4[2]}.${v4[3]}`;
  if (!v.includes(":")) return null;
  const [h, t] = v.split("::"); const hs = h ? h.split(":") : []; const ts = t !== undefined && t ? t.split(":") : [];
  const g = t === undefined ? hs : [...hs, ...Array(Math.max(0, 8 - hs.length - ts.length)).fill("0"), ...ts];
  return `6:${g.slice(0, 3).map((x) => (parseInt(x || "0", 16) || 0).toString(16)).join(":")}`;
}
/** GP-3: NON-refundable failure budget. Every failed upstream call (meta or callback) costs one unit from the caller's
 * network and from the global bucket for the hour; once either is spent we answer 429 without calling upstream. The
 * ordinary per-request budget above is still refunded on failure, so honest retries after an outage are not double-billed. */
function failLimits(ip: string | null, salt: string): Limit[] {
  const hr = Math.floor(Date.now() / 3_600_000); const net = failNet(ip);
  const nh = net ? (salt ? bytesToHex(hmac(sha256, utf8ToBytes(salt), utf8ToBytes(`km-lnf-fail:${net}`))).slice(0, 24) : "unsalted") : null;
  return [...(nh ? [{ k: `lnf:f:ip:${nh}:${hr}`, limit: FORWARD_LIMITS.failPerNetPerHour, ttlS: 7200 }] : []), { k: `lnf:f:g:${hr}`, limit: FORWARD_LIMITS.failGlobalPerHour, ttlS: 7200 }];
}
async function failBudgetSpent(db: D1Database | undefined, ip: string | null, salt: string): Promise<Response | null> {
  if (!db) return null;
  try {
    for (const l of failLimits(ip, salt)) { const r = await db.prepare("SELECT n FROM rate_limits WHERE k = ?").bind(l.k).first<{ n: number }>(); if ((r?.n ?? 0) >= l.limit) return err("too many failed upstream requests, try later", 429); }
  } catch { return err("temporary error", 503); }
  return null;
}
async function chargeFailure(db: D1Database | undefined, ip: string | null, salt: string): Promise<void> {
  if (!db) return; for (const l of failLimits(ip, salt)) { try { await take(db, l); } catch { /* best effort */ } }
}
/** GP-1: replay guard. One D1 row per payment_hash with a 24h TTL; a hash seen before is refused. In-memory fallback without D1. */
const seenMem = new Map<string, number>();
export const resetReplayMemory = () => seenMem.clear();
async function firstSeen(db: D1Database | undefined, hash: string): Promise<boolean> {
  if (!db) { const now = Date.now(); for (const [k, t] of seenMem) if (t < now) seenMem.delete(k); if (seenMem.has(hash)) return false; seenMem.set(hash, now + FORWARD_LIMITS.replayTtlS * 1000); return true; }
  return take(db, { k: `lnf:ph:${hash}`, limit: 1, ttlS: FORWARD_LIMITS.replayTtlS });
}
/** Cached upstream payRequest; a cache hit costs no budget. A miss spends meta budget, refunded if the fetch fails. */
async function upstreamMeta(url: string, o: { fetcher?: F; doh?: F }, db: D1Database | undefined, ip: string | null, salt: string): Promise<UpstreamMeta | Response> {
  const c = cache.get(url); if (c && Date.now() - c.at < FORWARD_LIMITS.cacheTtlMs) return c.meta;
  const fb = await failBudgetSpent(db, ip, salt); if (fb) return fb;
  const b = await spend(db, "m", ip, salt); if ("denied" in b) return b.denied;
  let meta: UpstreamMeta | null = null;
  try { const r = await guardedFetch(url, o); meta = r.ok ? parseMeta(r.text, new URL(url).hostname.toLowerCase()) : null; } catch { meta = null; }
  if (!meta) { await b.refund(); await chargeFailure(db, ip, salt); return err("upstream wallet unavailable", 502); }
  cache.set(url, { at: Date.now(), meta });
  return meta;
}

/** Checks on an upstream invoice before we hand it to a payer: mainnet, node signature (payee recovered from it, and
 * equal to the 'n' tag when present), amount, expiry, and the payee pin when `payeePin` is given. Returns payee,
 * payment_hash and description_hash for the caller's replay and hash checks. */
export function checkForwardInvoice(pr: string, amountMsat: number, nowS = Math.floor(Date.now() / 1000), payeePin?: string): { ok: true; description_hash: string | null; payee: string; payment_hash: string } | { ok: false; reason: string } {
  if (!/^lnbc(?!rt)[0-9]*[munp]?1/i.test(pr)) return { ok: false, reason: "upstream invoice is not a mainnet invoice" };
  const b = verifyBolt11(pr);
  if (!b) return { ok: false, reason: "upstream invoice failed to decode or its signature is invalid" };
  if (b.amount_msat !== amountMsat) return { ok: false, reason: "upstream invoice amount mismatch" };
  if (b.timestamp + b.expiry_s <= nowS + 30) return { ok: false, reason: "upstream invoice expired" };
  if (payeePin && b.payee.toLowerCase() !== payeePin) return { ok: false, reason: "upstream invoice payee node is not the pinned node" };
  return { ok: true, description_hash: b.description_hash, payee: b.payee, payment_hash: b.payment_hash };
}
/** GET /.well-known/lnurlp/<name> and GET /.well-known/lnurlp/<name>/callback. Returns null for other paths. */
export async function handleLnurlForward(path: string, url: URL, env: { DB?: D1Database; LNURL_FORWARD_ZAP?: string; SUBMIT_SALT?: string; SITE_ZAP_PUBKEY_HEX?: string; ZAP_PAYEE_NODE_PUBKEY?: string; ZAP_REQUIRE_DESCRIPTION_HASH?: string }, origin: string, ip: string | null, salt: string, o: { fetcher?: F; doh?: F } = {}): Promise<Response | null> {
  const m = /^\/\.well-known\/lnurlp\/([^/]+)(\/callback)?$/.exec(path); if (!m) return null;
  const name = m[1].toLowerCase(); const up = name === "zap" ? upstreamUrl(env.LNURL_FORWARD_ZAP) : null;
  if (!up) return err("unknown lightning address", 404);
  // R9-002: validate the caller's input BEFORE taking rate-limit budget (meta-dependent bounds are checked after).
  // R9-009: amount must be a plain decimal integer string (no 1e3, 0x10, spaces, signs or fractions).
  const amtRaw = url.searchParams.get("amount") ?? ""; const amount = /^[1-9]\d{0,14}$/.test(amtRaw) ? Number(amtRaw) : NaN;
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
  const fb = await failBudgetSpent(env.DB, ip, salt); if (fb) return fb;
  const budget = await spend(env.DB, "c", ip, salt); if ("denied" in budget) return budget.denied;
  const fail = async (reason: string) => { await budget.refund(); await chargeFailure(env.DB, ip, salt); return err(reason, 502); };
  let r: Awaited<ReturnType<typeof guardedFetch>>; try { r = await guardedFetch(cb.toString(), o); } catch { return fail("upstream wallet unavailable"); }
  if (!r.ok) return fail("upstream wallet unavailable");
  let inv: { pr?: unknown; reason?: unknown }; try { inv = JSON.parse(r.text); } catch { return fail("upstream returned no JSON"); }
  if (typeof inv.pr !== "string") return fail("upstream returned no invoice") // R9-008: never echo the upstream's reason text;
  // GP-1 invoice checks. Always required: mainnet, node signature decodes (payee = key recovered from the signature,
  // and equal to the 'n' tag when one is present), amount == requested msat, not expired, payment_hash not seen in the
  // last 24h. Payee pin: when ZAP_PAYEE_NODE_PUBKEY is set the payee must equal it (else 502). When it is UNSET we log a
  // warning and mark the response unverified instead of refusing, so prod tips keep working until the pin is set.
  // description_hash: zaps compare it with sha256(9734 as sent), plain payments with sha256(upstream metadata). Primal
  // currently commits to neither (constant f5e3ee15..., checked 2026-10-31), so a mismatch or missing hash marks the
  // response unverified rather than failing; set ZAP_REQUIRE_DESCRIPTION_HASH="1" to refuse instead. See docs/DEPLOY-lnurlp-zap.md.
  const pinRaw = (env.ZAP_PAYEE_NODE_PUBKEY ?? "").trim().toLowerCase();
  if (pinRaw && !/^0[23][0-9a-f]{64}$/.test(pinRaw)) return fail("payee pin misconfigured");
  const ck = checkForwardInvoice(inv.pr, amount, undefined, pinRaw || undefined);
  if (!ck.ok) return fail(ck.reason);
  const unverified: string[] = [];
  if (!pinRaw) { console.warn("lnurl-forward: ZAP_PAYEE_NODE_PUBKEY unset; payee node not pinned"); unverified.push("payee_node_not_pinned"); }
  const expectDh = bytesToHex(sha256(utf8ToBytes(nostr !== null ? nostr : meta.metadata)));
  if (ck.description_hash !== expectDh) {
    if (env.ZAP_REQUIRE_DESCRIPTION_HASH === "1") return fail("upstream invoice description_hash mismatch");
    unverified.push(nostr !== null ? "description_hash_not_zap_request" : "description_hash_not_metadata");
  }
  try { if (!(await firstSeen(env.DB, ck.payment_hash))) return fail("upstream reused an invoice"); } catch { return fail("temporary error"); }
  return Response.json({ status: "OK", pr: inv.pr, routes: [], klickymart_check: { verified: unverified.length === 0, payee: ck.payee, ...(unverified.length ? { unverified } : {}) } },
    { headers: { ...CORS, "X-KlickyMart-Invoice-Check": unverified.length ? `unverified; ${unverified.join(",")}` : "verified" } });
}
