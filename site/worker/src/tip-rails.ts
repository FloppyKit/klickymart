/** Tipping rails (t90u): Lightning zaps (NIP-57), plain Lightning tips (LUD-06/16) and Cashu nutzaps (NIP-61).
 * KlickyMart never holds keys, funds, NWC strings or Cashu proofs: the Worker only proxies the public LNURL-pay
 * metadata + callback fetch to obtain a bolt11, and reads public events from the D1 index. Every event is signed and
 * published by the user's own signer in the browser. Nothing here adds ranking weight. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { verifyNostrEvent } from "./nostr-verify";
import { verifyBolt11 } from "./bolt11";
import { checkZapReceipt } from "./pay-binding";
import { ipHash } from "./submissions";
import { takeAll, type Limit } from "./ratelimit";
import { payUrlFromProfile, publicHost } from "./nostr-app";

type Ev = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
type F = (url: string, init?: RequestInit) => Promise<Response>;
const HEX64 = /^[0-9a-f]{64}$/;
const LUD16 = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;
export const ZAP_REQUEST = 9734, ZAP_RECEIPT = 9735, NUTZAP = 9321, NUTZAP_INFO = 10019;
export const TIP_TARGET_KINDS = [422, 421, 0, 1];
export const INVOICE_LIMITS = { perNetPerHour: 60, perKeyPerHour: 30, globalPerHour: 1200, minMsat: 1000, maxMsat: 1_000_000_000, maxBody: 32768, timeoutMs: 4000 };
/** Mints the /app page may talk to directly (CSP connect-src). Override with CASHU_MINTS (comma list of origins). */
export const DEFAULT_CASHU_MINTS = ["https://mint.minibits.cash", "https://mint.coinos.io", "https://mint.cubabitcoin.org", "https://mint.macadamia.cash", "https://stablenut.umint.cash"];
/** Relays a browser-only NWC connection may use (CSP connect-src). Override with NWC_RELAYS. */
export const DEFAULT_NWC_RELAYS = ["wss://relay.getalby.com", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.damus.io"];
const ORIGIN_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$|^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/;
const WSS_RE = /^wss:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$|^ws:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/;
const csv = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim().toLowerCase().replace(/\/+$/, "")).filter(Boolean);
export function cashuMints(env: { CASHU_MINTS?: string }): string[] { const l = csv(env.CASHU_MINTS).filter((m) => ORIGIN_RE.test(m)); return l.length ? l : DEFAULT_CASHU_MINTS; }
export function nwcRelays(env: { NWC_RELAYS?: string }): string[] { const l = csv(env.NWC_RELAYS).filter((m) => WSS_RE.test(m)); return l.length ? l : DEFAULT_NWC_RELAYS; }

// ---------- SSRF + DNS-rebinding guard ----------
/** Private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges (v4 and v6). */
function parseV4(s: string): number[] | null {
  // inet_aton-style: 1-4 parts, each decimal, 0x hex or 0-leading octal; the last part fills the remaining bytes.
  const parts = s.split("."); if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = Number(p);
    else return null;
    nums.push(n);
  }
  const last = nums.pop()!; if (nums.some((n) => n > 255) || last >= 2 ** (8 * (4 - nums.length))) return null;
  const out = [...nums]; for (let i = 4 - nums.length - 1; i >= 0; i--) out.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return out;
}
function parseV6(s: string): number[] | null {
  s = s.replace(/%.*$/, ""); // zone id
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const v = parseV4(m[2]!); if (!v || !/^\d+\.\d+\.\d+\.\d+$/.test(m[2]!)) return null; s = `${m[1]}${((v[0]! << 8) | v[1]!).toString(16)}:${((v[2]! << 8) | v[3]!).toString(16)}`; }
  const halves = s.split("::"); if (halves.length > 2) return null;
  const grp = (x: string) => (x === "" ? [] : x.split(":"));
  const head = grp(halves[0]!), tail = halves.length === 2 ? grp(halves[1]!) : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail].map((g) => parseInt(g, 16));
}
function privateV4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113) || (a === 192 && b === 88 && c === 99);
}
/** Private, loopback, link-local, CGNAT, multicast, reserved and documentation ranges (v4 and v6). GP-4: parsed numerically, fails closed on anything unparseable. */
export function privateIp(ip: string): boolean {
  const s = String(ip).toLowerCase().trim().replace(/^\[|\]$/g, "");
  if (!s.includes(":")) { const v = parseV4(s); return v ? privateV4(v) : true; }
  const g = parseV6(s); if (!g) return true;
  const v4 = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0 && g[6] === 0 ? true : privateV4(v4); // ::, ::1, mapped, compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard 100::/64
  if (g[0] === 0x2001 && (g[1] === 0xdb8 || g[1]! < 0x200)) return true; // documentation, Teredo/IETF protocol 2001::/23
  if (g[0] === 0x2002) return true; // 6to4
  if (g[0] === 0x3fff && g[1]! < 0x1000) return true; // documentation 3fff::/20
  const h = g[0]!;
  return (h & 0xfe00) === 0xfc00 || (h & 0xffc0) === 0xfe80 || (h & 0xffc0) === 0xfec0 || (h & 0xff00) === 0xff00 || h === 0;
}
/** Resolve A + AAAA over DNS-over-HTTPS; null when nothing resolves, else the sorted address list. */
export async function resolveHost(host: string, doh: F): Promise<string[] | null> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const r = await doh(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const j = await r.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) out.push(a.data);
  }
  return out.length ? out.sort() : null;
}
export { readCapped } from "./capped-read";
import { readCapped } from "./capped-read";
/** Fetch a public https URL: public hostname, every resolved address public before AND after the request (a changed
 * answer = possible rebinding -> refuse the body), no redirects, timeout, size cap. Workers cannot pin the connect IP,
 * so the post-check is the mitigation; Cloudflare egress also cannot reach private networks. */
export async function guardedFetch(url: string, o: { fetcher?: F; doh?: F } = {}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  let u: URL; try { u = new URL(url); } catch { return { ok: false, reason: "bad url" }; }
  if (u.protocol !== "https:" || u.port || u.username || u.password || !publicHost(u.hostname)) return { ok: false, reason: "url must be https on a public hostname" };
  const doh = o.doh ?? fetch, fetcher = o.fetcher ?? fetch;
  try {
    const before = await resolveHost(u.hostname, doh);
    if (!before || before.some(privateIp)) return { ok: false, reason: "host does not resolve to public addresses" };
    const r = await fetcher(u.toString(), { redirect: "manual", headers: { Accept: "application/json", "User-Agent": "KlickyMart tip proxy (+https://klickymart.com/bot)" }, signal: AbortSignal.timeout(INVOICE_LIMITS.timeoutMs) });
    if (r.status !== 200) return { ok: false, reason: `upstream status ${r.status}` };
    // R9-005: enforce the size cap while reading (Content-Length first, then a streaming byte count), never after.
    const text = await readCapped(r, INVOICE_LIMITS.maxBody); if (text === null) return { ok: false, reason: "upstream response too large" };
    const after = await resolveHost(u.hostname, doh);
    if (!after || after.some(privateIp) || after.join(",") !== before.join(",")) return { ok: false, reason: "host address changed during the request" };
    return { ok: true, text };
  } catch { return { ok: false, reason: "upstream unreachable" }; }
}

// ---------- zap request ----------
export const ZAP_RELAYS = { max: 10, maxLen: 256 };
export function validRelayUrl(u: unknown): boolean {
  if (typeof u !== "string" || u.length > ZAP_RELAYS.maxLen || !/^wss:\/\/[^\s"<>\\]+$/i.test(u)) return false;
  try { const x = new URL(u); return x.protocol === "wss:" && !x.username && !x.password && publicHost(x.hostname); } catch { return false; }
}
export function validACoord(v: string): boolean {
  const m = /^(\d{1,5}):([0-9a-f]{64}):(.{0,256})$/s.exec(v); if (!m) return false;
  const k = Number(m[1]); return k >= 30000 && k < 40000;
}
export function aCoordPubkey(v: string): string | null { return validACoord(v) ? v.split(":")[1]! : null; }
export function verifyZapRequest(input: unknown, nowS = Math.floor(Date.now() / 1000)): { ok: true; ev: Ev; recipient: string; amount: number; target: string | null } | { ok: false; message: string } {
  if (!input || typeof input !== "object") return { ok: false, message: "zap_request must be a signed kind 9734 event" };
  const raw = JSON.stringify(input);
  if (raw.length > 4096 || /nsec1[02-9ac-hj-np-z]{20,}|nostr\+walletconnect:|cashu[AB][A-Za-z0-9_-]{20,}/i.test(raw)) return { ok: false, message: "zap request too large or contains a secret" };
  const ev = input as Ev;
  const v = verifyNostrEvent(ev as never, ZAP_REQUEST); if (!v.ok) return { ok: false, message: `zap request: ${v.reason}` };
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return { ok: false, message: "tags must be string arrays" };
  if (Math.abs(ev.created_at - nowS) > 600) return { ok: false, message: "zap request created_at must be within 10 minutes" };
  const p = ev.tags.filter((t) => t[0] === "p"); if (p.length !== 1 || !HEX64.test(p[0][1] ?? "")) return { ok: false, message: "exactly one p tag" };
  const e = ev.tags.filter((t) => t[0] === "e"); if (e.length > 1 || (e[0] && !HEX64.test(e[0][1] ?? ""))) return { ok: false, message: "at most one e tag" };
  // R12-003: one relays tag, 1..ZAP_RELAYS.max entries, each a wss:// URL to a public host, length-capped.
  const rt = ev.tags.filter((t) => t[0] === "relays"); if (rt.length !== 1 || rt[0].length < 2) return { ok: false, message: "exactly one relays tag required" };
  const rl = rt[0].slice(1);
  if (rl.length > ZAP_RELAYS.max || !rl.every(validRelayUrl)) return { ok: false, message: `relays tag: 1-${ZAP_RELAYS.max} wss:// relay URLs, each at most ${ZAP_RELAYS.maxLen} chars` };
  // R12-001: an a tag must be a proper parameterized-replaceable coordinate <kind>:<pubkey hex>:<d>.
  const a = ev.tags.filter((t) => t[0] === "a"); if (a.length > 1 || (a[0] && !validACoord(a[0][1] ?? ""))) return { ok: false, message: "at most one a tag, formatted <kind 30000-39999>:<64 hex pubkey>:<d>" };
  const amount = Number(ev.tags.find((t) => t[0] === "amount")?.[1]);
  if (!Number.isInteger(amount) || amount < INVOICE_LIMITS.minMsat || amount > INVOICE_LIMITS.maxMsat) return { ok: false, message: "amount tag (msat) required" };
  return { ok: true, ev, recipient: p[0][1], amount, target: e[0]?.[1] ?? null };
}

// ---------- invoice proxy ----------
interface PayMeta { callback: string; minSendable: number; maxSendable: number; metadata: string; allowsNostr?: boolean; nostrPubkey?: string; commentAllowed?: number; tag: string }
export interface InvoiceInput { recipient?: unknown; lud16?: unknown; amount_msat?: unknown; zap_request?: unknown; comment?: unknown }
export async function getInvoice(db: D1Database | undefined, body: InvoiceInput, o: { salt: string; ip: string | null; fetcher?: F; doh?: F; nowMs?: number }): Promise<{ status: number; body: Record<string, unknown> }> {
  const bad = (code: string, message: string, status = 400) => ({ status, body: { ok: false, error: { code, message } } });
  if (!body || typeof body !== "object") return bad("bad_body", "JSON body required");
  if (/nsec1[02-9ac-hj-np-z]{20,}|nostr\+walletconnect:|cashu[AB][A-Za-z0-9_-]{20,}/i.test(JSON.stringify(body))) return bad("secret_sent", "never send a key, NWC string or Cashu token");
  let amount = Number(body.amount_msat); let zap: Extract<ReturnType<typeof verifyZapRequest>, { ok: true }> | null = null;
  let recipient = typeof body.recipient === "string" ? body.recipient.toLowerCase() : null;
  if (body.zap_request !== undefined) {
    const z = verifyZapRequest(body.zap_request, Math.floor((o.nowMs ?? Date.now()) / 1000)); if (!z.ok) return bad("bad_zap_request", z.message);
    zap = z; if (recipient && recipient !== z.recipient) return bad("recipient_mismatch", "recipient differs from the zap request p tag");
    recipient = z.recipient; if (body.amount_msat !== undefined && amount !== z.amount) return bad("amount_mismatch", "amount_msat differs from the zap request amount tag"); amount = z.amount;
  }
  if (!Number.isInteger(amount) || amount < INVOICE_LIMITS.minMsat || amount > INVOICE_LIMITS.maxMsat) return bad("bad_amount", `amount_msat must be an integer from ${INVOICE_LIMITS.minMsat} to ${INVOICE_LIMITS.maxMsat}`);
  let pay: { addr: string; url: string } | null = null;
  if (recipient) {
    if (!HEX64.test(recipient)) return bad("bad_recipient", "recipient must be a 64-hex pubkey");
    pay = db ? await profilePay(db, recipient) : null;
    if (!pay) return bad("no_lightning", "recipient has no Lightning address in a verified kind 0 profile we hold", 404);
  } else if (typeof body.lud16 === "string") {
    const m = LUD16.exec(body.lud16.trim().toLowerCase());
    if (!m || !publicHost(m[2])) return bad("bad_lud16", "lud16 must be name@public-domain");
    pay = { addr: `${m[1]}@${m[2]}`, url: `https://${m[2]}/.well-known/lnurlp/${m[1]}` };
  } else return bad("no_target", "give recipient (pubkey), lud16, or a zap_request");
  const comment = typeof body.comment === "string" ? body.comment.slice(0, 280) : "";
  if (db) {
    const hr = Math.floor((o.nowMs ?? Date.now()) / 3_600_000); const ipH = ipHash(o.ip, o.salt, o.nowMs);
    const lim: Limit[] = [...(ipH ? [{ k: `inv:ip:${ipH}:${hr}`, limit: INVOICE_LIMITS.perNetPerHour, ttlS: 7200 }] : []),
      ...(zap ? [{ k: `inv:pk:${zap.ev.pubkey}:${hr}`, limit: INVOICE_LIMITS.perKeyPerHour, ttlS: 7200 }] : []),
      { k: `inv:g:${hr}`, limit: INVOICE_LIMITS.globalPerHour, ttlS: 7200 }];
    let refused: Limit | null; try { refused = await takeAll(db, lim); } catch { return bad("limiter_unavailable", "temporary error, please retry", 503); }
    if (refused) return bad("rate_limited", "too many invoice requests, try later", 429);
  }
  const m1 = await guardedFetch(pay.url, o); if (!m1.ok) return bad("lnurl_unreachable", m1.reason, 502);
  let meta: PayMeta; try { meta = JSON.parse(m1.text) as PayMeta; } catch { return bad("lnurl_bad", "pay endpoint did not return JSON", 502); }
  if (meta.tag !== "payRequest" || typeof meta.callback !== "string" || typeof meta.metadata !== "string") return bad("lnurl_bad", "not a LUD-06 payRequest", 502);
  if (!(amount >= meta.minSendable && amount <= meta.maxSendable)) return bad("amount_out_of_range", `amount must be ${meta.minSendable}..${meta.maxSendable} msat`);
  if (zap && !(meta.allowsNostr === true && typeof meta.nostrPubkey === "string" && HEX64.test(meta.nostrPubkey))) return bad("zaps_unsupported", "this Lightning address does not support zaps; send a plain tip instead");
  let cb: URL; try { cb = new URL(meta.callback); } catch { return bad("lnurl_bad", "bad callback", 502); }
  cb.searchParams.set("amount", String(amount));
  const zapJson = zap ? JSON.stringify(zap.ev) : null;
  if (zapJson) { cb.searchParams.set("nostr", zapJson); cb.searchParams.set("lnurl", bech32.encode("lnurl", bech32.toWords(utf8ToBytes(pay.url)), 2000)); }
  else if (comment && (meta.commentAllowed ?? 0) >= comment.length) cb.searchParams.set("comment", comment);
  const r2 = await guardedFetch(cb.toString(), o); if (!r2.ok) return bad("callback_failed", r2.reason, 502);
  let inv: { pr?: unknown; status?: unknown; reason?: unknown; verify?: unknown }; try { inv = JSON.parse(r2.text); } catch { return bad("callback_bad", "callback did not return JSON", 502); }
  if (typeof inv.pr !== "string") return bad("callback_bad", "the wallet returned no invoice", 502); // R9-008: never echo upstream text
  const b = verifyBolt11(inv.pr);
  if (!b) return bad("bad_invoice", "invoice failed to decode or its signature is invalid", 502);
  if (b.amount_msat !== amount) return bad("bad_invoice", "invoice amount differs from the requested amount", 502);
  const wantHash = bytesToHex(sha256(utf8ToBytes(zapJson ?? meta.metadata)));
  if (b.description_hash !== wantHash) return bad("bad_invoice", zapJson ? "invoice is not bound to this zap request (description_hash)" : "invoice description_hash does not match the LNURL metadata", 502);
  return { status: 200, body: { ok: true, pr: inv.pr, amount_msat: amount, payment_hash: b.payment_hash, expiry_s: b.expiry_s, addr: pay.addr, zap: !!zap, zap_request_id: zap?.ev.id ?? null, zapper_pubkey: zap ? meta.nostrPubkey : null,
    verify_url: typeof inv.verify === "string" && inv.verify.startsWith("https://") ? inv.verify : null, custody: "You pay the recipient's wallet directly. KlickyMart never touches the funds." } };
}
async function profilePay(db: D1Database, pk: string): Promise<{ addr: string; url: string } | null> {
  const r = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = 0 AND pubkey = ? ORDER BY created_at DESC LIMIT 1").bind(pk).first<{ raw_json: string }>().catch(() => null);
  let ev: Ev | null = null; try { ev = r ? JSON.parse(r.raw_json) as Ev : null; } catch { ev = null; }
  if (!ev || ev.pubkey !== pk || !verifyNostrEvent(ev as never, 0).ok) return null;
  return payUrlFromProfile(ev.content);
}

// ---------- receipts ----------
/** Find the kind 9735 receipt for a zap request we proxied: it must embed the exact signed request (description tag). */
export async function findReceipt(db: D1Database | undefined, zapRequestId: string, zapper: string | null): Promise<{ found: boolean; receipt?: Ev; sats?: number | null; validated?: boolean }> {
  if (!db || !HEX64.test(zapRequestId)) return { found: false };
  const { results } = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = ? AND instr(raw_json, ?) > 0 ORDER BY created_at DESC LIMIT 5").bind(ZAP_RECEIPT, zapRequestId).all<{ raw_json: string }>();
  for (const row of results ?? []) {
    let ev: Ev; try { ev = JSON.parse(row.raw_json) as Ev; } catch { continue; }
    if (!verifyNostrEvent(ev as never, ZAP_RECEIPT).ok) continue;
    let req: Ev | null = null; try { req = JSON.parse(ev.tags.find((t) => t[0] === "description")?.[1] ?? "null") as Ev; } catch { req = null; }
    if (req?.id !== zapRequestId) continue;
    const b = verifyBolt11(ev.tags.find((t) => t[0] === "bolt11")?.[1] ?? "");
    const validated = !!zapper && HEX64.test(zapper) && checkZapReceipt(ev, zapper).ok;
    return { found: true, receipt: ev, sats: b?.amount_msat != null ? Math.floor(b.amount_msat / 1000) : null, validated };
  }
  return { found: false };
}

// ---------- Cashu (NIP-61) ----------
export interface NutzapInfo { pubkey: string; mints: string[]; relays: string[]; p2pk: string | null; id: string; created_at: number }
export function parseNutzapInfo(ev: Ev): NutzapInfo | null {
  if (ev.kind !== NUTZAP_INFO || !verifyNostrEvent(ev as never, NUTZAP_INFO).ok) return null;
  const mints = [...new Set(ev.tags.filter((t) => t[0] === "mint" && typeof t[1] === "string").map((t) => t[1].trim().toLowerCase().replace(/\/+$/, "")).filter((m) => ORIGIN_RE.test(m) || /^https:\/\/[a-z0-9.-]+(\/[a-z0-9._\/-]*)?$/.test(m)))].slice(0, 20);
  const relays = [...new Set(ev.tags.filter((t) => t[0] === "relay" && typeof t[1] === "string").map((t) => t[1].trim().toLowerCase().replace(/\/+$/, "")).filter((r) => WSS_RE.test(r)))].slice(0, 20);
  const pk = ev.tags.find((t) => t[0] === "pubkey")?.[1]?.toLowerCase() ?? null;
  const p2pk = pk && /^(02|03)?[0-9a-f]{64}$/.test(pk) ? (pk.length === 64 ? "02" + pk : pk) : null;
  return { pubkey: ev.pubkey.toLowerCase(), mints, relays, p2pk, id: ev.id, created_at: ev.created_at };
}
export async function nutzapInfoOf(db: D1Database | undefined, pk: string): Promise<NutzapInfo | null> {
  if (!db) return null;
  const r = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = ? AND pubkey = ? ORDER BY created_at DESC LIMIT 1").bind(NUTZAP_INFO, pk).first<{ raw_json: string }>().catch(() => null);
  try { const i = r ? parseNutzapInfo(JSON.parse(r.raw_json) as Ev) : null; return i && i.pubkey === pk && i.mints.length && i.p2pk ? i : null; } catch { return null; }
}
export interface Nutzap { id: string; target: string | null; recipient: string | null; tipper: string; sats: number; mint: string | null; locked_to_recipient: boolean; mint_listed: boolean; created_at: number }
/** Display-only parse of a kind 9321. sats = sum of proof amounts (claimed). locked_to_recipient = every proof is a
 * NUT-11 P2PK secret locked to the recipient's 10019 pubkey; mint_listed = mint is in their 10019. Mint signatures are
 * not checked here (that needs the mint), so amounts are labelled "claimed" unless both checks pass. */
export function parseNutzap(ev: Ev, info: NutzapInfo | null): Nutzap | null {
  if (ev.kind !== NUTZAP || !verifyNostrEvent(ev as never, NUTZAP).ok) return null;
  const proofs = ev.tags.filter((t) => t[0] === "proof").map((t) => { try { return JSON.parse(t[1]) as { amount?: unknown; secret?: unknown }; } catch { return null; } });
  if (!proofs.length || proofs.some((p) => !p || typeof p.amount !== "number" || !Number.isInteger(p.amount) || p.amount <= 0 || typeof p.secret !== "string")) return null;
  const unit = ev.tags.find((t) => t[0] === "unit")?.[1] ?? "sat"; if (unit !== "sat") return null;
  const mint = ev.tags.find((t) => t[0] === "u")?.[1]?.toLowerCase().replace(/\/+$/, "") ?? null;
  const lockedTo = (s: string) => { try { const j = JSON.parse(s) as [string, { data?: string }]; return j[0] === "P2PK" ? (j[1]?.data ?? "").toLowerCase() : null; } catch { return null; } };
  const locked = !!info?.p2pk && proofs.every((p) => lockedTo(p!.secret as string) === info.p2pk);
  return { id: ev.id, target: ev.tags.find((t) => t[0] === "e")?.[1] ?? null, recipient: ev.tags.find((t) => t[0] === "p")?.[1] ?? null, tipper: ev.pubkey,
    sats: proofs.reduce((a, p) => a + (p!.amount as number), 0), mint, locked_to_recipient: locked, mint_listed: !!mint && !!info?.mints.includes(mint), created_at: ev.created_at };
}
/** Nutzaps per target note id that pass the lock + listed-mint checks (display only; never fed into ranking). */
export async function loadNutzaps(db: D1Database | undefined, ids: string[]): Promise<Map<string, Nutzap[]>> {
  const out = new Map<string, Nutzap[]>(); if (!db || !ids.length) return out;
  const want = new Set(ids); const infos = new Map<string, NutzapInfo | null>();
  const { results } = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = ? ORDER BY created_at DESC LIMIT 2000").bind(NUTZAP).all<{ raw_json: string }>().catch(() => ({ results: [] as { raw_json: string }[] }));
  for (const r of results ?? []) {
    let ev: Ev; try { ev = JSON.parse(r.raw_json) as Ev; } catch { continue; }
    const p = ev.tags.find((t) => t[0] === "p")?.[1]; const e = ev.tags.find((t) => t[0] === "e")?.[1];
    if (!e || !want.has(e) || !p) continue;
    if (!infos.has(p)) infos.set(p, await nutzapInfoOf(db, p));
    const n = parseNutzap(ev, infos.get(p) ?? null); if (!n || n.tipper === n.recipient) continue;
    // R8-007: a 9321 only counts when every proof is P2PK-locked to the author's 10019 key AND the mint is in that
    // 10019. Even then the amount stays "claimed": mint signatures (C / DLEQ) are not checked server-side.
    if (!n.locked_to_recipient || !n.mint_listed || n.recipient !== p) continue;
    (out.get(e) ?? out.set(e, []).get(e)!).push(n);
  }
  return out;
}
