/** Nostr-app features: NIP-98-style login (kind 27235 signed challenge, never a key), feed reads over our D1 index,
 * NIP-51 feed-subscription lists (verified here, never stored or published by KlickyMart), tip-ready badges and the
 * optional value-for-value site tip slot. KlickyMart never sees secret keys, holds funds or publishes events. */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { verifyNostrEvent } from "./nostr-verify";
import { ipHash } from "./submissions";
import { takeAll, type Limit } from "./ratelimit";

type Ev = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };

export const AUTH_KIND = 27235;
export const FEED_LIST_KIND = 30015; // NIP-51 interest set; d tag namespaced "klickymart-feed:<name>"
export const FEED_LIST_D_PREFIX = "klickymart-feed:";
export const FEED_KINDS = [31420, 420, 421, 422, 1] as const;
export const NOTE_TAG = "klickymart";
export const SUGGESTED_TAGS = ["btc", "x402", "agent-native", "phonereq"];
/** Relays the /app page may talk to (CSP connect-src). NIP-46 bunkers must use one of these. */
export const APP_RELAYS = ["wss://relay.primal.net", "wss://nos.lol", "wss://relay.damus.io", "wss://relay.nsec.app"];
export const AUTH_LIMITS = { perNetPerHour: 30, perKeyPerHour: 10, challengeTtlS: 120, sessionTtlS: 7 * 86400, clockSkewS: 60 };
export const LIST_LIMITS = { perNetPerHour: 120, perKeyPerHour: 60, maxItems: 64 };
export const TIP_LIMITS = { perNetPerHour: 60, globalPerHour: 600, cacheTtlS: 86400, maxPubkeys: 50 };
const HEX64 = /^[0-9a-f]{64}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TAGW = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LUD16 = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

const mac = (secret: string, msg: string) => bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(msg)));
const ctEq = (a: string, b: string) => { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; };
export const authSecret = (env: { AUTH_SECRET?: string; SUBMIT_SALT?: string }): string | null => env.AUTH_SECRET || env.SUBMIT_SALT || null;

// ---------- challenge + login ----------
export function makeChallenge(secret: string, nowS = Math.floor(Date.now() / 1000)): string {
  const r = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return `${nowS}.${r}.${mac(secret, `km-ch:${nowS}.${r}`).slice(0, 32)}`;
}
export function checkChallenge(secret: string, c: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const m = /^(\d{10})\.([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(c);
  if (!m) return false;
  const ts = Number(m[1]);
  if (ts > nowS + 5 || nowS - ts > AUTH_LIMITS.challengeTtlS) return false;
  return ctEq(m[3], mac(secret, `km-ch:${m[1]}.${m[2]}`).slice(0, 32));
}
const tagv = (ev: Ev, k: string) => ev.tags.find((t) => t[0] === k)?.[1];
const looksSecret = (s: string) => /nsec1[02-9ac-hj-np-z]{20,}|bunker:\/\/[^"]*secret=|nostr\+walletconnect:/i.test(s);

/** NIP-98-style auth event: kind 27235, u = <origin>/auth/login, method = POST, challenge tag, fresh created_at, valid sig. */
export function verifyAuthEvent(input: unknown, origin: string, secret: string, nowS = Math.floor(Date.now() / 1000)): { ok: true; pubkey: string; challenge: string; id: string } | { ok: false; code: string; message: string } {
  if (!input || typeof input !== "object") return { ok: false, code: "bad_event", message: "send {event: <signed kind 27235>}" };
  const raw = JSON.stringify(input);
  if (raw.length > 4096) return { ok: false, code: "too_large", message: "event too large" };
  if (looksSecret(raw)) return { ok: false, code: "secret_sent", message: "never send a secret key or connection secret" };
  const ev = input as Ev;
  const v = verifyNostrEvent(ev as never, AUTH_KIND);
  if (!v.ok) return { ok: false, code: "bad_signature", message: `${v.reason} (expected a signed kind ${AUTH_KIND})` };
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return { ok: false, code: "bad_tags", message: "tags must be string arrays" };
  if (Math.abs(ev.created_at - nowS) > AUTH_LIMITS.clockSkewS) return { ok: false, code: "bad_time", message: "created_at must be within 60 s of now" };
  if (tagv(ev, "u") !== `${origin}/auth/login`) return { ok: false, code: "bad_url", message: `u tag must be ${origin}/auth/login` };
  if ((tagv(ev, "method") ?? "").toUpperCase() !== "POST") return { ok: false, code: "bad_method", message: "method tag must be POST" };
  const ch = tagv(ev, "challenge") ?? "";
  if (!checkChallenge(secret, ch, nowS)) return { ok: false, code: "bad_challenge", message: "challenge missing, expired or not issued here" };
  return { ok: true, pubkey: ev.pubkey.toLowerCase(), challenge: ch, id: ev.id };
}

/** Limiter order (R5): network first, then the one-time challenge (per-event), then the key. takeAll gives back on refusal. */
export function authLimitList(ipH: string | null, challenge: string, pubkey: string, nowMs = Date.now()): Limit[] {
  const hr = Math.floor(nowMs / 3_600_000);
  return [
    ...(ipH ? [{ k: `auth:ip:${ipH}:${hr}`, limit: AUTH_LIMITS.perNetPerHour, ttlS: 7200 }] : []),
    { k: `auth:ch:${challenge}`, limit: 1, ttlS: AUTH_LIMITS.challengeTtlS * 2 },
    { k: `auth:pk:${pubkey}:${hr}`, limit: AUTH_LIMITS.perKeyPerHour, ttlS: 7200 },
  ];
}

export function makeSession(secret: string, pubkey: string, nowS = Math.floor(Date.now() / 1000)): string {
  const exp = nowS + AUTH_LIMITS.sessionTtlS;
  return `${pubkey}.${exp}.${mac(secret, `km-sess:${pubkey}.${exp}`)}`;
}
export function readSession(secret: string | null, cookie: string | null, nowS = Math.floor(Date.now() / 1000)): string | null {
  if (!secret || !cookie) return null;
  const m = /(?:^|;\s*)km_sess=([0-9a-f]{64})\.(\d{10})\.([0-9a-f]{64})(?:;|$)/.exec(cookie);
  if (!m || Number(m[2]) < nowS) return null;
  return ctEq(m[3], mac(secret, `km-sess:${m[1]}.${m[2]}`)) ? m[1] : null;
}
export const sessionCookie = (v: string, secure: boolean) => `km_sess=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_LIMITS.sessionTtlS}${secure ? "; Secure" : ""}`;
export const clearCookie = (secure: boolean) => `km_sess=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

export async function login(db: D1Database | undefined, body: unknown, o: { origin: string; secret: string | null; ip: string | null; nowMs?: number }): Promise<{ status: number; body: Record<string, unknown>; cookie?: string }> {
  if (!o.secret) return { status: 503, body: { ok: false, error: { code: "auth_disabled", message: "login is not configured on this deployment" } } };
  if (!db) return { status: 503, body: { ok: false, error: { code: "storage_error", message: "rate-limit storage not ready" } } };
  const nowMs = o.nowMs ?? Date.now();
  const ev = (body && typeof body === "object" && "event" in body) ? (body as { event: unknown }).event : body;
  const v = verifyAuthEvent(ev, o.origin, o.secret, Math.floor(nowMs / 1000));
  if (!v.ok) return { status: 400, body: { ok: false, error: { code: v.code, message: v.message } } };
  let refused: Limit | null;
  try { refused = await takeAll(db, authLimitList(ipHash(o.ip, o.secret, nowMs), v.challenge, v.pubkey, nowMs), Math.floor(nowMs / 1000)); }
  catch { return { status: 503, body: { ok: false, error: { code: "limiter_unavailable", message: "temporary error, please retry", retryable: true } } }; }
  if (refused) {
    if (refused.k.startsWith("auth:ch:")) return { status: 400, body: { ok: false, error: { code: "challenge_used", message: "this challenge was already used; get a new one" } } };
    return { status: 429, body: { ok: false, error: { code: "rate_limited", message: "too many logins, try later", retryable: true, retry_after_s: 600 } } };
  }
  return { status: 200, body: { ok: true, pubkey: v.pubkey, expires_in_s: AUTH_LIMITS.sessionTtlS }, cookie: makeSession(o.secret, v.pubkey, Math.floor(nowMs / 1000)) };
}

// ---------- feed ----------
export interface FeedFilter { kinds: number[]; stores: string[]; tags: string[]; authors: string[]; limit: number; until?: number }
export function parseFeedParams(sp: URLSearchParams): { ok: true; value: FeedFilter } | { ok: false; message: string } {
  const list = (k: string) => sp.getAll(k).flatMap((v) => v.split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const kinds = list("kind").map(Number);
  if (kinds.some((k) => !(FEED_KINDS as readonly number[]).includes(k))) return { ok: false, message: `kind must be one of ${FEED_KINDS.join(", ")}` };
  const stores = list("store"); if (stores.some((d) => !DOMAIN.test(d))) return { ok: false, message: "store must be a domain" };
  const tags = list("tag"); if (tags.some((t) => !TAGW.test(t))) return { ok: false, message: "tag must be [a-z0-9-], at most 32 chars" };
  const authors = list("author"); if (authors.some((a) => !HEX64.test(a))) return { ok: false, message: "author must be a 64-char hex pubkey" };
  if (stores.length + tags.length + authors.length + kinds.length > LIST_LIMITS.maxItems) return { ok: false, message: "too many filter values" };
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit")) || 50));
  const until = sp.get("until") ? Number(sp.get("until")) : undefined;
  if (until !== undefined && !Number.isInteger(until)) return { ok: false, message: "until must be a unix timestamp" };
  return { ok: true, value: { kinds: kinds.length ? kinds : [...FEED_KINDS], stores, tags, authors, limit, until } };
}
export function feedMatch(ev: Ev, f: FeedFilter): boolean {
  if (!f.kinds.includes(ev.kind)) return false;
  const ts = ev.tags.filter((t) => t[0] === "t").map((t) => String(t[1]).toLowerCase());
  if (ev.kind === 1 && !ts.includes(NOTE_TAG)) return false;
  if (f.authors.length && !f.authors.includes(ev.pubkey.toLowerCase())) return false;
  if (f.tags.length && !f.tags.some((t) => ts.includes(t))) return false;
  if (f.stores.length) {
    const ds = ev.tags.filter((t) => t[0] === "d" || t[0] === "r").map((t) => String(t[1]).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    if (!f.stores.some((s) => ds.includes(s))) return false;
  }
  return true;
}
/** Reads verified events from the D1 index; every returned event is re-verified here (id + BIP-340 sig). */
export async function readFeed(db: D1Database | undefined, f: FeedFilter, extra: Ev[] = []): Promise<Ev[]> {
  const out: Ev[] = [];
  const seen = new Set<string>();
  const push = (ev: Ev) => { if (!seen.has(ev.id) && feedMatch(ev, f) && verifyNostrEvent(ev as never, ev.kind).ok) { seen.add(ev.id); out.push(ev); } };
  if (db) {
    const where = [`kind IN (${f.kinds.map(() => "?").join(",")})`, "id NOT IN (SELECT id FROM revoked_events)", "id NOT IN (SELECT id FROM tombstones WHERE tombstones.pubkey = nostr_events.pubkey)"];
    const binds: unknown[] = [...f.kinds];
    if (f.authors.length) { where.push(`pubkey IN (${f.authors.map(() => "?").join(",")})`); binds.push(...f.authors); }
    if (f.until) { where.push("created_at <= ?"); binds.push(f.until); }
    const { results } = await db.prepare(`SELECT raw_json FROM nostr_events WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 500`).bind(...binds).all<{ raw_json: string }>();
    for (const r of results ?? []) { try { push(JSON.parse(r.raw_json) as Ev); } catch { /* skip */ } if (out.length >= f.limit) break; }
  }
  for (const ev of extra) { if (out.length >= f.limit) break; if (!f.until || ev.created_at <= f.until) push(ev); }
  return out.sort((a, b) => b.created_at - a.created_at).slice(0, f.limit);
}

// ---------- NIP-51 feed lists ----------
export interface FeedList { name: string; kinds: number[]; stores: string[]; tags: string[]; authors: string[]; pubkey: string; id: string; created_at: number }
/** Verify and parse a user-signed kind 30015 feed list. KlickyMart neither stores nor publishes it. */
export function parseFeedList(input: unknown): { ok: true; value: FeedList } | { ok: false; code: string; message: string } {
  if (!input || typeof input !== "object") return { ok: false, code: "bad_event", message: "send {event: <signed kind 30015>}" };
  const raw = JSON.stringify(input);
  if (raw.length > 16384) return { ok: false, code: "too_large", message: "event too large" };
  if (looksSecret(raw)) return { ok: false, code: "secret_sent", message: "never send a secret key or connection secret" };
  const ev = input as Ev;
  const v = verifyNostrEvent(ev as never, FEED_LIST_KIND);
  if (!v.ok) return { ok: false, code: v.reason.startsWith("wrong kind") ? "bad_kind" : "bad_signature", message: v.reason };
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return { ok: false, code: "bad_tags", message: "tags must be string arrays" };
  const d = tagv(ev, "d") ?? "";
  if (!d.startsWith(FEED_LIST_D_PREFIX) || d.length > 96) return { ok: false, code: "bad_d", message: `d tag must start with ${FEED_LIST_D_PREFIX}` };
  const l: FeedList = { name: d.slice(FEED_LIST_D_PREFIX.length), kinds: [], stores: [], tags: [], authors: [], pubkey: ev.pubkey.toLowerCase(), id: ev.id, created_at: ev.created_at };
  for (const t of ev.tags) {
    const x = (t[1] ?? "").toLowerCase();
    if (t[0] === "k") { const n = Number(x); if (!(FEED_KINDS as readonly number[]).includes(n)) return { ok: false, code: "bad_item", message: `k must be one of ${FEED_KINDS.join(", ")}` }; l.kinds.push(n); }
    else if (t[0] === "t") { if (!TAGW.test(x)) return { ok: false, code: "bad_item", message: "bad t tag" }; l.tags.push(x); }
    else if (t[0] === "p") { if (!HEX64.test(x)) return { ok: false, code: "bad_item", message: "bad p tag" }; l.authors.push(x); }
    else if (t[0] === "r") { if (!DOMAIN.test(x)) return { ok: false, code: "bad_item", message: "bad r tag" }; l.stores.push(x); }
  }
  if (l.kinds.length + l.tags.length + l.authors.length + l.stores.length > LIST_LIMITS.maxItems) return { ok: false, code: "too_many", message: `at most ${LIST_LIMITS.maxItems} items` };
  return { ok: true, value: l };
}
export function listLimitList(ipH: string | null, eventId: string, pubkey: string, nowMs = Date.now()): Limit[] {
  const hr = Math.floor(nowMs / 3_600_000);
  return [
    ...(ipH ? [{ k: `fl:ip:${ipH}:${hr}`, limit: LIST_LIMITS.perNetPerHour, ttlS: 7200 }] : []),
    { k: `fl:pk:${pubkey}:${hr}`, limit: LIST_LIMITS.perKeyPerHour, ttlS: 7200 },
  ];
}
export async function checkFeedList(db: D1Database | undefined, body: unknown, o: { salt: string; ip: string | null; nowMs?: number }): Promise<{ status: number; body: Record<string, unknown> }> {
  const ev = (body && typeof body === "object" && "event" in body) ? (body as { event: unknown }).event : body;
  const p = parseFeedList(ev);
  if (!p.ok) return { status: 400, body: { ok: false, error: { code: p.code, message: p.message } } };
  if (db) {
    let refused: Limit | null;
    try { refused = await takeAll(db, listLimitList(ipHash(o.ip, o.salt, o.nowMs), p.value.id, p.value.pubkey, o.nowMs)); }
    catch { return { status: 503, body: { ok: false, error: { code: "limiter_unavailable", message: "temporary error, please retry", retryable: true } } }; }
    if (refused) return { status: 429, body: { ok: false, error: { code: "rate_limited", message: "too many list checks, try later", retryable: true } } };
  }
  return { status: 200, body: { ok: true, stored: false, published: false, list: p.value, feed_query: feedQueryString(p.value) } };
}
export const feedQueryString = (l: Pick<FeedList, "kinds" | "stores" | "tags" | "authors">) => {
  const q = new URLSearchParams();
  if (l.kinds.length) q.set("kind", l.kinds.join(",")); if (l.stores.length) q.set("store", l.stores.join(","));
  if (l.tags.length) q.set("tag", l.tags.join(",")); if (l.authors.length) q.set("author", l.authors.join(","));
  return q.toString();
};

// ---------- tip-ready ----------
/** Lightning pay endpoint for a kind 0 profile: lud16 (name@host) or lud06 (bech32 LNURL). https only, public hostnames only. */
export function payUrlFromProfile(content: string): { addr: string; url: string } | null {
  let c: { lud16?: unknown; lud06?: unknown };
  try { c = JSON.parse(content) as typeof c; } catch { return null; }
  if (!c || typeof c !== "object") return null;
  if (typeof c.lud16 === "string") {
    const m = LUD16.exec(c.lud16.trim().toLowerCase());
    if (m && publicHost(m[2])) return { addr: `${m[1]}@${m[2]}`, url: `https://${m[2]}/.well-known/lnurlp/${m[1]}` };
  }
  if (typeof c.lud06 === "string" && /^lnurl1[02-9ac-hj-np-z]+$/i.test(c.lud06.trim())) {
    try {
      const d = bech32.decode(c.lud06.trim().toLowerCase() as `${string}1${string}`, 2000);
      const u = new URL(new TextDecoder().decode(bech32.fromWords(d.words)));
      if (u.protocol === "https:" && publicHost(u.hostname) && !u.port && !u.username && !u.password) return { addr: c.lud06.trim().toLowerCase(), url: u.toString() };
    } catch { /* invalid */ }
  }
  return null;
}
export function publicHost(h: string): boolean {
  const s = h.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(s) || !s.includes(".")) return false;
  if (/^\d+(\.\d+){3}$/.test(s) || /^\d+$/.test(s.replace(/\./g, ""))) return false; // IP literals
  return !/(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid|onion)$/.test(s);
}
/** A pay endpoint "works" when it answers a LUD-06 payRequest with an https callback and sane sendable range. */
export async function probePayUrl(url: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetcher(url, { redirect: "manual", headers: { Accept: "application/json", "User-Agent": "KlickyMart tip-ready check (+https://klickymart.com/bot)" }, signal: AbortSignal.timeout(4000) });
    if (r.status !== 200) return false;
    const t = await r.text(); if (t.length > 32768) return false;
    const j = JSON.parse(t) as { tag?: unknown; callback?: unknown; minSendable?: unknown; maxSendable?: unknown };
    if (j.tag !== "payRequest" || typeof j.callback !== "string" || !j.callback.startsWith("https://")) return false;
    return typeof j.minSendable === "number" && typeof j.maxSendable === "number" && j.minSendable > 0 && j.maxSendable >= j.minSendable;
  } catch { return false; }
}
export interface TipReady { pubkey: string; tip_ready: boolean; addr: string | null; checked_at: number | null; ranking_weight: 0 }
/** tip-ready badges. NEVER used for ranking: ranking_weight is always 0 and nothing in query/ranking reads tip_ready_cache. */
export async function tipReadyFor(db: D1Database | undefined, pubkeys: string[], o: { salt: string; ip: string | null; fetcher?: typeof fetch; nowMs?: number }): Promise<TipReady[]> {
  const nowS = Math.floor((o.nowMs ?? Date.now()) / 1000);
  const out: TipReady[] = [];
  for (const pk of pubkeys) {
    const none: TipReady = { pubkey: pk, tip_ready: false, addr: null, checked_at: null, ranking_weight: 0 };
    if (!db) { out.push(none); continue; }
    const prof = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = 0 AND pubkey = ? ORDER BY created_at DESC LIMIT 1").bind(pk).first<{ raw_json: string }>().catch(() => null);
    let ev: Ev | null = null; try { ev = prof ? JSON.parse(prof.raw_json) as Ev : null; } catch { ev = null; }
    if (!ev || !verifyNostrEvent(ev as never, 0).ok || ev.pubkey.toLowerCase() !== pk) { out.push(none); continue; }
    const pay = payUrlFromProfile(ev.content);
    if (!pay) { out.push(none); continue; }
    const c = await db.prepare("SELECT ok, checked_at FROM tip_ready_cache WHERE pubkey = ? AND addr = ?").bind(pk, pay.addr).first<{ ok: number; checked_at: number }>().catch(() => null);
    if (c && nowS - c.checked_at < TIP_LIMITS.cacheTtlS) { out.push({ pubkey: pk, tip_ready: !!c.ok, addr: pay.addr, checked_at: c.checked_at, ranking_weight: 0 }); continue; }
    const hr = Math.floor(nowS / 3600);
    const ipH = ipHash(o.ip, o.salt, o.nowMs);
    const refused = await takeAll(db, [...(ipH ? [{ k: `tr:ip:${ipH}:${hr}`, limit: TIP_LIMITS.perNetPerHour, ttlS: 7200 }] : []), { k: `tr:g:${hr}`, limit: TIP_LIMITS.globalPerHour, ttlS: 7200 }], nowS).catch(() => ({ k: "err", limit: 0, ttlS: 0 }));
    if (refused) { out.push({ pubkey: pk, tip_ready: c ? !!c.ok : false, addr: pay.addr, checked_at: c?.checked_at ?? null, ranking_weight: 0 }); continue; }
    const ok = await probePayUrl(pay.url, o.fetcher);
    await db.prepare("INSERT INTO tip_ready_cache (pubkey, addr, ok, checked_at) VALUES (?,?,?,?) ON CONFLICT(pubkey, addr) DO UPDATE SET ok=excluded.ok, checked_at=excluded.checked_at").bind(pk, pay.addr, ok ? 1 : 0, nowS).run().catch(() => undefined);
    out.push({ pubkey: pk, tip_ready: ok, addr: pay.addr, checked_at: nowS, ranking_weight: 0 });
  }
  return out;
}

// ---------- value-for-value site tip slot ----------
/** SITE_TIP_LUD16 (env var). Unset or malformed -> null, and the slot stays hidden. No default address exists. */
export function siteTipAddress(env: { SITE_TIP_LUD16?: string }): string | null {
  const v = (env.SITE_TIP_LUD16 ?? "").trim().toLowerCase();
  const m = LUD16.exec(v);
  return m && publicHost(m[2]) ? v : null;
}
