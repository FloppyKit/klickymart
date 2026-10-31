import { hmac } from "@noble/hashes/hmac.js";
import { takeAll } from "./ratelimit";
import { BIG_NIP05_PROVIDERS } from "./nip05";
/** Path 3: community store submission + trust ladder (trust_tier). Separate from the record's `trust` (domain-age) object.
 * Submitters only give a domain, a category hint and a note: facts come from the gated crawl, which the box crawler runs
 * (crawler/gate.py) after reading GET /submit/queue.ndjson. Nothing is ever hidden; every tier is a label.
 * No raw IPs: rate limits use a salted, week-bucketed SHA-256 prefix. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { verifyNostrEvent } from "./nostr-verify";
import { NOSTR_KIND_STORE_SUGGESTION } from "./nostr-kinds";
import { GATE_BLOCKLIST } from "./submit-blocklist";
import { PROBE_402 } from "./probe-402";
const PROBE_BY_D = new Map(PROBE_402.filter((p) => p.result === "verified-402" && p.http === 402).map((p) => [p.d, p]));

export const SUBMIT_LIMITS = { perDay: 10, perWeek: 50, lowRepPerDay: 1, noteMax: 280, maxSubdomainsPerRegistrable: 3, reviewRepBelow: -3 };
export const TIERS = ["flagged", "unverified", "seen", "verified"] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_RANK: Record<Tier, number> = { flagged: 0, unverified: 1, seen: 2, verified: 3 };
export const SEEN_RULE = { windowS: 60 * 86400, weighted: 3, realKeys: 2, newKeyWeight: 0.5, realAgeS: 30 * 86400, realOtherDomains: 2, sybilWindowS: 86400, dropFlaggedShare: 0.4 };
export const TRUST_RULES = "trust_tier ladder (never hides a store; each tier is a label): flagged = a strong abuse signal (spam, affiliate redirect, look-alike of an indexed domain, sub-domain stuffing), still listed with the reason. unverified = newly submitted (src=community) or crawler-indexed with no shopper basis yet. seen = at least 3 weighted distinct unflagged keys with visit-basis notes (kind 421 or 422 basis=visit) in 60 days, new or anonymous keys count 0.5, at least 2 real keys (age >= 30 days or unflagged notes on >= 2 other stores); the submitter's own key and keys first seen within 24 h of the submission do not count; drops back if > 40% of basis notes are flagged. verified = any ONE real proof, shown in trust_proofs[] and the label (seen is not required first): a payment proof (verified 422 from an unflagged key that is not the submitter), a store claim (DNS TXT at _klickymart.<domain> naming the npub plus a claim signed by that key, or a key verified by NIP-05 on the domain that also signed a 31420 for it), or a crawler-observed protocol endpoint (/.well-known/ucp present, or a real HTTP 402 challenge from our own probe; directory-claimed rails do not count). 'verified' is protocol/ownership/payment-proof only, NOT a fulfillment or legitimacy check; trust_dimensions {protocol_verified, ownership_verified, payment_proof, checkout_accessible, merchant_legitimacy: not-assessed} separates them.";

export interface SubmitFlag { flag: string; strength: "weak" | "strong"; detail: string }
const STRONG_TIER_FLAGS = new Set(["spam", "affiliate-redirect", "lookalike?", "subdomain-stuffing"]);

// ---------- domain normalization ----------
const TWO_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "com.br", "com.mx", "co.in", "co.za", "com.cn", "com.tw", "com.hk", "com.sg", "co.kr", "com.tr", "com.ar"]);
export function registrable(host: string): string {
  const p = host.split(".");
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join(".");
  return TWO_LEVEL.has(last2) ? p.slice(-3).join(".") : last2;
}
const AFFILIATE_HOSTS = ["amzn.to", "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "rebrand.ly", "shareasale.com", "awin1.com", "linksynergy.com", "click.linksynergy.com", "skimresources.com", "go.skimresources.com", "anrdoezrs.net", "jdoqocy.com", "tkqlhce.com", "dpbolvw.net", "kqzyfj.com", "prf.hn", "pjtra.com", "pntra.com", "tidd.ly", "rstyle.me", "shopstyle.it", "howl.me", "sovrn.co", "narrativ.com", "impact.com", "sjv.io", "ojrq.net", "evyy.net", "avantlink.com", "cj.com", "flexlinkspro.com", "geni.us", "linktr.ee"];
const AFF_PARAM = /^(ref|ref_|refid|aff|aff_id|affid|affiliate|affiliate_id|tag|ascsubtag|irclickid|clickid|gclid|fbclid|ranmid|ransiteid|ranEAID|cjevent|utm_[a-z]+|subid|sub_id|partner|coupon|promo|via|sscid|awc|mc_cid)$/i;
const BAD_TLD = /\.(invalid|test|example|localhost|local|internal|onion|arpa)$/;

export type NormOk = { ok: true; domain: string; input_host: string; stripped: string[]; flags: SubmitFlag[]; unicode: string | null };
export function normalizeSubmitDomain(input: unknown): NormOk | { ok: false; code: string; message: string } {
  if (typeof input !== "string" || !input.trim()) return { ok: false, code: "bad_domain", message: "domain is required (a store hostname like shop.example)" };
  const raw = input.trim().slice(0, 300);
  const stripped: string[] = []; const flags: SubmitFlag[] = [];
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, code: "bad_domain", message: "not a valid domain" }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, code: "bad_domain", message: "http(s) domains only" };
  if (u.username || u.password) return { ok: false, code: "bad_domain", message: "no credentials in the domain" };
  if (u.pathname !== "/" || u.search || u.hash) stripped.push("path/query (only the bare domain is stored)");
  const affParams = [...u.searchParams.keys()].filter((k) => AFF_PARAM.test(k));
  if (affParams.length) flags.push({ flag: "affiliate-param", strength: "weak", detail: `referral/tracking parameter(s) stripped: ${affParams.slice(0, 5).join(", ")}` });
  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.port) stripped.push("port");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[")) return { ok: false, code: "bad_domain", message: "IP addresses are not stores; submit a domain" };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.split(".").some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return { ok: false, code: "bad_domain", message: "not a valid public domain" };
  if (BAD_TLD.test(host) || !/\.[a-z]{2,}$|\.xn--[a-z0-9-]+$/.test(host)) return { ok: false, code: "bad_domain", message: "reserved or non-public domain" };
  if (AFFILIATE_HOSTS.some((a) => host === a || host.endsWith("." + a))) return { ok: false, code: "affiliate_host", message: "that is a link shortener or affiliate network, not a store; submit the store's own domain" };
  const input_host = host.replace(/^www\./, "");
  const domain = registrable(input_host);
  if (domain !== input_host) stripped.push(`sub-domain (${input_host} -> ${domain})`);
  const unicode = host.split(".").some((l) => l.startsWith("xn--")) ? domain.split(".").map((l) => (l.startsWith("xn--") ? punyDecode(l.slice(4)) ?? l : l)).join(".") : null;
  if (unicode) flags.push({ flag: "idn", strength: "weak", detail: `internationalized (punycode) domain; displays as ${unicode}` });
  return { ok: true, domain, input_host, stripped, flags, unicode };
}

/** RFC 3492 punycode decode of one label (without the xn-- prefix). */
export function punyDecode(s: string): string | null {
  const base = 36, tmin = 1, tmax = 26, skew = 38, damp = 700;
  let n = 128, i = 0, bias = 72; const out: number[] = [];
  const b = s.lastIndexOf("-");
  for (let j = 0; j < Math.max(b, 0); j++) out.push(s.charCodeAt(j));
  const adapt = (delta: number, num: number, first: boolean) => { delta = first ? Math.floor(delta / damp) : delta >> 1; delta += Math.floor(delta / num); let k = 0; while (delta > ((base - tmin) * tmax) >> 1) { delta = Math.floor(delta / (base - tmin)); k += base; } return k + Math.floor(((base - tmin + 1) * delta) / (delta + skew)); };
  for (let idx = b > 0 ? b + 1 : 0; idx < s.length;) {
    const oldi = i; let w = 1;
    for (let k = base; ; k += base) {
      if (idx >= s.length) return null;
      const c = s.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1)); i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

// ---------- look-alikes ----------
const CONFUSABLE: Record<string, string> = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j", "ӏ": "l", "ѕ": "s", "ԁ": "d", "ɡ": "g", "ո": "n", "ν": "v", "ο": "o", "α": "a", "ı": "i", "0": "o", "1": "l", "3": "e", "5": "s", "@": "a" };
export function skeleton(s: string): string {
  return [...s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()].map((c) => CONFUSABLE[c] ?? c).join("").replace(/rn/g, "m").replace(/vv/g, "w").replace(/-/g, "");
}
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
const label = (d: string) => d.slice(0, d.indexOf("."));
/** Look-alike of an indexed brand domain: same confusable skeleton, or edit distance <= 2 (<= 1 for short names). */
export function lookalikeOf(domain: string, unicode: string | null, indexed: Iterable<string>): string | null {
  const regs = new Set<string>(); for (const d of indexed) regs.add(registrable(d));
  if (regs.has(domain)) return null;
  const mine = unicode ?? domain; const ml = label(mine); const sk = skeleton(ml);
  for (const r of regs) {
    const rl = label(r);
    if (rl.length < 4) continue;
    if (skeleton(rl) === sk && rl !== ml) return r;
    if (rl === ml) continue; // same brand name, different TLD: shown via `lookalike?` only when the TLD also differs by spelling
    const max = rl.length >= 6 ? 2 : 1;
    if (editDistance(ml, rl, max) <= max) return r;
  }
  for (const r of regs) if (label(r) === ml && r !== domain && label(r).length >= 5) return r; // brand.shop vs brand.com
  return null;
}

// ---------- note cleanup ----------
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|shop|store|co|xyz|top|link|click)\/\S*/gi;
const SPAM_RE = /\b(casino|viagra|cialis|porn|xxx|escort|payday loan|crypto giveaway|airdrop|double your|forex signals?|seo services?|backlinks?|buy followers|onlyfans|replica watches)\b/i;
export function cleanNote(note: unknown): { note: string | null; stripped: string[]; flags: SubmitFlag[] } {
  if (typeof note !== "string" || !note.trim()) return { note: null, stripped: [], flags: [] };
  const stripped: string[] = []; const flags: SubmitFlag[] = [];
  const links = note.match(URL_RE) ?? [];
  let t = note.replace(URL_RE, "[link removed]").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, " ").replace(/\s+/g, " ").trim();
  if (links.length) stripped.push(`${links.length} link(s) in note`);
  if (t.length > SUBMIT_LIMITS.noteMax) { t = t.slice(0, SUBMIT_LIMITS.noteMax); stripped.push(`note truncated to ${SUBMIT_LIMITS.noteMax} chars`); }
  if (SPAM_RE.test(note) || links.length > 2) flags.push({ flag: "spam", strength: "strong", detail: links.length > 2 ? `note carried ${links.length} links` : "note matches spam terms" });
  if (/\b(nsec1[0-9a-z]{20,}|[0-9a-f]{64})\b/i.test(t)) { t = t.replace(/\b(nsec1[0-9a-z]{20,}|[0-9a-f]{64})\b/gi, "[removed]"); stripped.push("key-like string removed from note"); }
  return { note: t || null, stripped, flags };
}

export function cleanEvidence(url: unknown, domain: string): { url: string | null; stripped: string[] } {
  if (typeof url !== "string" || !url.trim()) return { url: null, stripped: [] };
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" || registrable(u.hostname.toLowerCase().replace(/^www\./, "")) !== domain) return { url: null, stripped: ["evidence_url dropped (must be an https page on the submitted store's own domain)"] };
    return { url: `https://${u.hostname.toLowerCase()}${u.pathname}`.slice(0, 300), stripped: u.search || u.hash ? ["evidence_url query/fragment"] : [] };
  } catch { return { url: null, stripped: ["evidence_url dropped (not a URL)"] }; }
}

export function cleanCategory(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const t = c.toLowerCase().replace(/[^a-z0-9 &-]/g, "").trim().slice(0, 32);
  return t || null;
}

/** KM-013: keyed, week-bucketed HMAC-SHA256 prefix of the IP. The key is the SUBMIT_SALT secret; without it a random
 * per-isolate key is used (never a committed default), so the hash cannot be reversed by sweeping the IPv4 space.
 * Never stores or returns the IP itself. */
export function ipHash(ip: string | null, salt: string, now = Date.now()): string | null {
  if (!ip) return null;
  const week = Math.floor(now / (7 * 86400_000));
  // R5-005: no per-isolate fallback. Without the SUBMIT_SALT secret every caller shares one bucket (strict, and nothing
  // IP-derived is kept); submissions refuse outright (submitStore).
  if (!salt) return "unsalted";
  return bytesToHex(hmac(sha256, utf8ToBytes(salt), utf8ToBytes(`km-submit:${week}:${ipNetwork(ip)}`))).slice(0, 24);
}
/** R5-004: rate-limit by network, not address: the /64 for IPv6 (one subscriber's allocation), the /32 for IPv4. */
export function ipNetwork(ip: string): string {
  const s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = s.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!s.includes(":")) return s;
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : []; const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => (parseInt(g || "0", 16) || 0).toString(16)).join(":") + "::/64";
}
/** Random per-isolate key used only when no SUBMIT_SALT secret is configured (KM-013: no committed default salt). */
export function agentId(name: string, salt: string): string {
  return "agent:" + bytesToHex(sha256(utf8ToBytes(`km-agent:${salt}:${name.trim().toLowerCase().slice(0, 64)}`))).slice(0, 16);
}

// ---------- signed kind 1423 ----------
export interface SignedSuggestion { id: string; pubkey: string; created_at: number; domain: unknown; category: string | null; note: string; evidence_url: string | null }
export function parseSuggestionEvent(input: unknown, now = Date.now(), maxAgeS = 30 * 86400): { ok: true; value: SignedSuggestion } | { ok: false; code: string; message: string } {
  if (!input || typeof input !== "object") return { ok: false, code: "bad_event", message: "event must be an object" };
  const ev = input as { id: string; pubkey: string; sig: string; kind: number; created_at: number; tags: string[][]; content: string };
  if (JSON.stringify(ev).length > 8192) return { ok: false, code: "too_large", message: "event too large" };
  if (/nsec1|"(sk|seckey|privkey|secret)"/i.test(JSON.stringify(ev))) return { ok: false, code: "secret_sent", message: "never send a secret key" };
  const v = verifyNostrEvent(ev as never, NOSTR_KIND_STORE_SUGGESTION);
  if (!v.ok) return { ok: false, code: v.reason.startsWith("wrong kind") ? "bad_kind" : "bad_signature", message: `${v.reason} (expected a signed kind ${NOSTR_KIND_STORE_SUGGESTION})` };
  if (!ev.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return { ok: false, code: "bad_tags", message: "tags must be string arrays" };
  const nowS = Math.floor(now / 1000);
  if (ev.created_at > nowS + 600 || ev.created_at < nowS - maxAgeS) return { ok: false, code: "bad_time", message: "created_at out of range" };
  const r = ev.tags.find((t) => t[0] === "r")?.[1];
  if (!r) return { ok: false, code: "missing_r", message: "needs an [\"r\", <domain>] tag" };
  const cat = ev.tags.find((t) => t[0] === "t" && t[1] && t[1].toLowerCase() !== "klickymart")?.[1] ?? null;
  return { ok: true, value: { id: ev.id, pubkey: ev.pubkey.toLowerCase(), created_at: ev.created_at, domain: r, category: cleanCategory(cat), note: ev.content, evidence_url: ev.tags.find((t) => t[0] === "proof")?.[1] ?? null } };
}

// ---------- submit ----------
export interface SubmitInput { domain?: unknown; category?: unknown; note?: unknown; evidence_url?: unknown; submitter?: { npub?: unknown; agent_name?: unknown } | null; [k: string]: unknown }
export interface SubmitCtx { db?: D1Database; indexed: Set<string>; salt: string; ip: string | null; via: "post" | "mcp" | "nostr"; now?: number; dryRun?: boolean; signed?: SignedSuggestion; origin: string }
export interface SubmitResult { status: number; body: Record<string, unknown> }
const ALLOWED_FIELDS = new Set(["domain", "category", "note", "evidence_url", "submitter", "event", "dry_run"]);

export async function submitStore(input: SubmitInput, ctx: SubmitCtx): Promise<SubmitResult> {
  const now = ctx.now ?? Date.now(); const nowS = Math.floor(now / 1000);
  const ignored = Object.keys(input ?? {}).filter((k) => !ALLOWED_FIELDS.has(k));
  const n = normalizeSubmitDomain(ctx.signed ? ctx.signed.domain : input?.domain);
  if (!n.ok) return { status: 400, body: { ok: false, status: "rejected", reason: n.message, error: { code: n.code, message: n.message } } };
  const note = cleanNote(ctx.signed ? ctx.signed.note : input.note);
  const ev = cleanEvidence(ctx.signed ? ctx.signed.evidence_url : input.evidence_url, n.domain);
  const category = ctx.signed ? ctx.signed.category : cleanCategory(input.category);
  let submitter_kind: "npub" | "agent" | "anon" = "anon", submitter = "anon";
  const claimed = typeof input?.submitter?.npub === "string" ? input.submitter.npub : null;
  if (ctx.signed) { submitter_kind = "npub"; submitter = ctx.signed.pubkey; }
  else if (typeof input?.submitter?.agent_name === "string" && input.submitter.agent_name.trim()) { submitter_kind = "agent"; submitter = agentId(input.submitter.agent_name, ctx.salt); }
  if (!ctx.salt && (ctx.ip || submitter_kind === "agent")) return { status: 503, body: { ok: false, status: "rejected", reason: "submissions are not configured (SUBMIT_SALT unset)", error: { code: "not_configured", message: "SUBMIT_SALT unset; refusing rather than using a non-secret salt" } } };
  const ih = ipHash(ctx.ip, ctx.salt, now);
  const flags: SubmitFlag[] = [...n.flags, ...note.flags];
  const stripped = [...n.stripped, ...note.stripped, ...ev.stripped];
  const base = { domain: n.domain, ...(n.unicode ? { domain_unicode: n.unicode } : {}), via: ctx.via, submitted_by: submitter_kind === "npub" ? submitter : submitter_kind === "agent" ? submitter : "anon",
    ...(claimed ? { npub_claim_ignored: "an unsigned npub proves nothing; sign a kind 1423 note to submit as that key" } : {}),
    ...(stripped.length ? { stripped } : {}), ...(ignored.length ? { ignored_fields: ignored, ignored_note: "submitters can only set domain, category (hint), note and evidence_url; store facts come from the gated crawl" } : {}),
    dry_run: !!ctx.dryRun };

  const db = ctx.db;
  // R5-001: a replay of a signed 1423 we already hold is idempotent and must not spend anyone's quota.
  let replay = false;
  if (db && ctx.signed) { try { replay = !!(await db.prepare("SELECT 1 FROM store_submissions WHERE event_id = ? OR id = ?").bind(ctx.signed.id, ctx.signed.id).first()); } catch { /* table missing */ } }
  // rate limits (per key and per salted IP hash; reputation cut)
  if (db && !replay) {
    try {
      const keyRows = submitter !== "anon" ? await db.prepare("SELECT flags_json, created_at FROM store_submissions WHERE submitter = ? ORDER BY created_at DESC LIMIT 60").bind(submitter).all<{ flags_json: string; created_at: number }>() : { results: [] };
      const kr = keyRows.results ?? [];
      const last10 = kr.slice(0, 10); const flaggedShare = last10.length >= 2 ? last10.filter((r) => isTierFlagged(JSON.parse(r.flags_json))).length / last10.length : 0;
      const dayLimit = flaggedShare > 0.5 ? SUBMIT_LIMITS.lowRepPerDay : SUBMIT_LIMITS.perDay;
      const over = (rows: { created_at: number }[], lim: number, win: number) => rows.filter((r) => r.created_at > nowS - win).length >= lim;
      if (kr.length && (over(kr, dayLimit, 86400) || over(kr, SUBMIT_LIMITS.perWeek, 7 * 86400)))
        return { status: 429, body: { ok: false, status: "rejected", reason: "rate_limited", error: { code: "rate_limited", message: `submitter limit: ${dayLimit}/day and ${SUBMIT_LIMITS.perWeek}/week${dayLimit === 1 ? " (cut to 1/day: most recent submissions were flagged)" : ""}`, retry_after_s: 3600 }, ...base } };
      if (ih) {
        const ir = (await db.prepare("SELECT created_at FROM store_submissions WHERE ip_hash = ? AND created_at > ? LIMIT 60").bind(ih, nowS - 7 * 86400).all<{ created_at: number }>()).results ?? [];
        if (over(ir, SUBMIT_LIMITS.perDay, 86400) || over(ir, SUBMIT_LIMITS.perWeek, 7 * 86400))
          return { status: 429, body: { ok: false, status: "rejected", reason: "rate_limited", error: { code: "rate_limited", message: `network limit: ${SUBMIT_LIMITS.perDay}/day and ${SUBMIT_LIMITS.perWeek}/week per salted network hash`, retry_after_s: 3600 }, ...base } };
      }
      // KM-008: atomic per-key and per-network day caps (the scans above stay for the weekly and reputation rules).
      // R5-001: per-event take first (concurrent copies of one signed event count once), then network, then key.
      // R5-006: the takes get their own try; a limiter failure is a 503, not a silent skip of later checks.
      if (!ctx.dryRun) {
        const day = new Date(now).toISOString().slice(0, 10);
        let hit;
        try {
          hit = await takeAll(db, [
            ...(ctx.signed ? [{ k: `sub:ev:${ctx.signed.id}`, limit: 1, ttlS: 2 * 86400 }] : []),
            ...(ih ? [{ k: `sub:ip:${ih}:${day}`, limit: SUBMIT_LIMITS.perDay, ttlS: 2 * 86400 }] : []),
            ...(submitter !== "anon" ? [{ k: `sub:pk:${submitter}:${day}`, limit: dayLimit, ttlS: 2 * 86400 }] : []),
          ]);
        } catch { return { status: 503, body: { ok: false, status: "rejected", reason: "unavailable", error: { code: "unavailable", message: "rate limiter unavailable; try again later" }, ...base } }; }
        if (hit?.k.startsWith("sub:ev:")) replay = true;
        else if (hit) return { status: 429, body: { ok: false, status: "rejected", reason: "rate_limited", error: { code: "rate_limited", message: hit.k.startsWith("sub:ip") ? `network limit: ${SUBMIT_LIMITS.perDay}/day per salted network hash` : `submitter limit: ${dayLimit}/day`, retry_after_s: 3600 }, ...base } };
      }
      // sub-domain stuffing: same submitter sending > 3 sub-domains of one registrable domain
      if (submitter !== "anon" || ih) {
        const col = submitter !== "anon" ? "submitter" : "ip_hash";
        const r = await db.prepare(`SELECT COUNT(DISTINCT input_host) AS n FROM store_submissions WHERE ${col} = ? AND domain = ? AND input_host != domain`).bind(submitter !== "anon" ? submitter : ih, n.domain).first<{ n: number }>();
        if ((r?.n ?? 0) + (n.input_host !== n.domain ? 1 : 0) > SUBMIT_LIMITS.maxSubdomainsPerRegistrable) flags.push({ flag: "subdomain-stuffing", strength: "strong", detail: `more than ${SUBMIT_LIMITS.maxSubdomainsPerRegistrable} sub-domains of ${n.domain} from one submitter; collapsed to ${n.domain}` });
      }
    } catch { /* migration pending: fall through without limits only in tests without tables */ }
  }
  const la = lookalikeOf(n.domain, n.unicode, ctx.indexed);
  if (la) flags.push({ flag: "lookalike?", strength: "strong", detail: `${n.unicode ?? n.domain} looks like indexed ${la}` });

  let status: "queued" | "duplicate" | "rejected" = "queued"; let reason: string | null = null;
  const bl = GATE_BLOCKLIST[n.domain] ?? GATE_BLOCKLIST[n.input_host];
  if (bl) { status = "rejected"; reason = `gate blocklist: ${bl.split(/ \(|;/)[0]}`; }
  else if (ctx.indexed.has(n.domain) || ctx.indexed.has(`www.${n.domain}`) || ctx.indexed.has(n.input_host)) { status = "duplicate"; reason = "already indexed"; }
  let existing: { first_submission_id: string; state: string } | null = null;
  if (db && status === "queued") { try { existing = await db.prepare("SELECT first_submission_id, state FROM crawl_queue WHERE domain = ?").bind(n.domain).first(); } catch { /* */ } if (existing) { status = "duplicate"; reason = "already queued for the gated crawl"; } }
  let rep = 0;
  if (db && submitter !== "anon") rep = await submitterRep(db, submitter);
  const review = rep < SUBMIT_LIMITS.reviewRepBelow;
  const id = ctx.signed?.id ?? "sub_" + bytesToHex(sha256(utf8ToBytes(`${n.domain}|${submitter}|${now}|${Math.random()}`))).slice(0, 20);
  const tier: Tier = isTierFlagged(flags) ? "flagged" : "unverified";
  const out = { ok: status !== "rejected", id, status, reason, ...base, category_hint: category, note: note.note, evidence_url: ev.url, flags, submitter_rep: rep,
    ...(status === "queued" ? { queued: true, crawl: review ? "held for manual review (submitter reputation below -3)" : "queued for the gated crawl (robots.txt and ToS first; an error or 403 means disallow)" } : {}),
    trust_tier: status === "duplicate" && reason === "already indexed" ? undefined : tier, trust_label: status === "duplicate" && reason === "already indexed" ? undefined : tierLabel(tier, { src: "community", flags }),
    status_url: ctx.dryRun ? null : `${ctx.origin}/submit/${status === "duplicate" && existing ? existing.first_submission_id : id}`, rules: `${ctx.origin}/llms.txt#submit` };
  if (ctx.dryRun || !db) return { status: 200, body: { ...out, stored: false } };
  try {
    await db.prepare(`INSERT OR IGNORE INTO store_submissions (id,domain,input_host,category,note,evidence_url,via,submitter_kind,submitter,ip_hash,event_id,status,reason,flags_json,review,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, n.domain, n.input_host, category, note.note, ev.url, ctx.via, submitter_kind, submitter, ih, ctx.signed?.id ?? null, status, reason, JSON.stringify(flags), review ? 1 : 0, nowS).run();
    if (status === "queued") await db.prepare("INSERT INTO crawl_queue (domain, first_submission_id, category_hint, state, flags_json, queued_at, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(domain) DO NOTHING").bind(n.domain, id, category, review ? "review" : "pending", JSON.stringify(flags), nowS, nowS).run();
    else if (status === "duplicate" && existing) await db.prepare("UPDATE crawl_queue SET submissions = submissions + 1, updated_at = ? WHERE domain = ?").bind(nowS, n.domain).run();
  } catch { return { status: 503, body: { ok: false, error: { code: "storage_error", message: "submissions storage not ready" } } }; }
  clearTierCache();
  return { status: status === "queued" ? 201 : 200, body: { ...out, stored: true } };
}

export function isTierFlagged(flags: SubmitFlag[]): boolean { return flags.some((f) => f.strength === "strong" && STRONG_TIER_FLAGS.has(f.flag)); }

/** rep = submissions whose store reached seen/verified, minus 2 x flagged submissions. */
export async function submitterRep(db: D1Database, submitter: string): Promise<number> {
  try {
    const rows = (await db.prepare("SELECT domain, flags_json FROM store_submissions WHERE submitter = ? AND status != 'rejected' ORDER BY created_at DESC LIMIT 100").bind(submitter).all<{ domain: string; flags_json: string }>()).results ?? [];
    if (!rows.length) return 0;
    const flagged = rows.filter((r) => isTierFlagged(JSON.parse(r.flags_json))).length;
    const tiers = await computeTrustTiers(db, [...new Set(rows.map((r) => r.domain))], () => null, Date.now(), { skipRep: true });
    const good = rows.filter((r) => { const t = tiers.get(r.domain)?.trust_tier; return t === "seen" || t === "verified"; }).length;
    return good - 2 * flagged;
  } catch { return 0; }
}

// ---------- trust ladder ----------
export interface TrustWhy { kind: string; ref?: string; detail: string }
export interface TrustInfo { trust_tier: Tier; trust_proofs: string[]; trust_label: string; trust_why: TrustWhy[]; src: "crawler" | "community"; submitted_by?: string; submitted_at?: string; seen: { weighted: number; keys: number; real_keys: number; basis_notes: number; flagged_notes: number }; trust_ts: string }
export function tierLabel(t: Tier, o: { src: string; flags?: SubmitFlag[]; n?: number; how?: string[] }): string {
  if (t === "flagged") return `Flagged: ${(o.flags ?? []).filter((f) => f.strength === "strong").map((f) => f.flag).join(", ") || "abuse signal"}`;
  if (t === "unverified") return o.src === "community" ? "Unverified · community-submitted" : "Unverified · crawler-indexed";
  if (t === "seen") return `Seen by shoppers · ${o.n ?? 0} visits`;
  return `Verified${o.how?.length ? ` (${o.how.join("; ")})` : ""}`;
}

type RawLike = Record<string, unknown> | null;
let CACHE: { at: number; key: string; map: Map<string, TrustInfo> } | null = null;
export function clearTierCache() { CACHE = null; }

/** Trust tiers for domains. `rawOf(d)` gives the crawl record (for protocol endpoints). A few bulk queries, cached 60 s. */
export async function computeTrustTiers(db: D1Database | undefined, domains: string[], rawOf: (d: string) => RawLike, now = Date.now(), opts: { skipRep?: boolean; noCache?: boolean } = {}): Promise<Map<string, TrustInfo>> {
  const key = domains.join(",");
  if (!opts.noCache && !opts.skipRep && CACHE && CACHE.key === key && now - CACHE.at < 60_000) return CACHE.map;
  const nowS = Math.floor(now / 1000);
  const want = new Set(domains);
  const subs = new Map<string, { submitter: string; submitter_kind: string; created_at: number; flags: SubmitFlag[] }>();
  type B = { id: string; d: string; pubkey: string; created_at: number; proof_status: string | null; kind: number };
  let notes: B[] = []; const flagW = new Map<string, number>(); const firstSeen = new Map<string, number>();
  const claims = new Set<string>(); const rep = new Map<string, number>(); const dnsClaims = new Map<string, string>();
  if (db) {
    try {
      for (const r of (await db.prepare("SELECT domain, submitter, submitter_kind, created_at, flags_json FROM store_submissions WHERE status = 'queued' ORDER BY created_at ASC").all<{ domain: string; submitter: string; submitter_kind: string; created_at: number; flags_json: string }>()).results ?? []) {
        const f = JSON.parse(r.flags_json) as SubmitFlag[];
        const prev = subs.get(r.domain);
        if (!prev) subs.set(r.domain, { submitter: r.submitter, submitter_kind: r.submitter_kind, created_at: r.created_at, flags: f });
        else for (const x of f) if (!prev.flags.some((y) => y.flag === x.flag)) prev.flags.push(x);
        if (!opts.skipRep && isTierFlagged(f)) rep.set(r.submitter, (rep.get(r.submitter) ?? 0) - 2);
      }
    } catch { /* migration pending */ }
    try { notes = ((await db.prepare("SELECT id, d, pubkey, created_at, proof_status, kind FROM experiences WHERE kind = 422 AND basis = 'visit'").all<B>()).results ?? []); } catch { /* */ }
    try { notes.push(...((await db.prepare("SELECT id, d, pubkey, created_at, NULL AS proof_status, kind FROM nostr_events WHERE kind = 421 AND d IS NOT NULL AND pubkey != '138fdf32b9275166bf20083f97e1fa31a6c271dd0c15725a26258084c3b52dcb' AND id NOT IN (SELECT id FROM revoked_events)").all<B>()).results ?? [])); } catch { /* */ }
    try { for (const r of (await db.prepare("SELECT id, weight, reasons_json FROM note_flags").all<{ id: string; weight: number; reasons_json: string }>()).results ?? []) if (r.reasons_json !== "[]") flagW.set(r.id, r.weight); } catch { /* */ }
    // KM-007: a key's age is when KlickyMart first saw it (ingest time), not the author-chosen created_at.
    try { for (const r of (await db.prepare("SELECT pubkey, MIN(first_seen) AS t FROM nostr_events GROUP BY pubkey").all<{ pubkey: string; t: number }>()).results ?? []) firstSeen.set(r.pubkey, r.t); } catch { /* */ }
    try { for (const r of (await db.prepare("SELECT pubkey, MIN(received_day) AS day FROM experiences GROUP BY pubkey").all<{ pubkey: string; day: string }>()).results ?? []) {
      const t = Math.floor(Date.parse(`${r.day}T00:00:00Z`) / 1000); const cur = firstSeen.get(r.pubkey);
      if (Number.isFinite(t) && (cur === undefined || t < cur)) firstSeen.set(r.pubkey, t);
    } } catch { /* */ }
    try { for (const r of (await db.prepare("SELECT domain, pubkey FROM store_claims WHERE status = 'active'").all<{ domain: string; pubkey: string }>()).results ?? []) dnsClaims.set(r.domain, r.pubkey); } catch { /* migration pending */ }
    // KM-005: a NIP-05 store claim needs the domain identity "_@<store domain>" (not any user name), the NIP-05 domain must
    // equal the record's d, and open NIP-05 providers never count (a user handle there says nothing about owning the store).
    try { for (const r of (await db.prepare("SELECT n.domain AS d, n.pubkey AS pk, n.nip05 AS nip05 FROM nip05_checks n JOIN site_records s ON s.pubkey = n.pubkey AND s.d = n.domain WHERE n.status = 'verified'").all<{ d: string; pk: string; nip05: string | null }>()).results ?? []) {
      const id = String(r.nip05 ?? "").toLowerCase(); const dd = String(r.d).toLowerCase();
      if ((id === `_@${dd}` || id === dd) && !BIG_NIP05_PROVIDERS.has(dd)) claims.add(`${r.d}|${r.pk}`);
    } } catch { /* */ }
  }
  const strongKeys = new Set(notes.filter((n) => flagW.get(n.id) === 0).map((n) => n.pubkey));
  const domsByKey = new Map<string, Set<string>>();
  for (const n of notes) if (!flagW.has(n.id)) (domsByKey.get(n.pubkey) ?? domsByKey.set(n.pubkey, new Set()).get(n.pubkey)!).add(n.d);
  const byD = new Map<string, B[]>();
  for (const n of notes) if (want.has(n.d)) (byD.get(n.d) ?? byD.set(n.d, []).get(n.d)!).push(n);
  const out = new Map<string, TrustInfo>();
  for (const d of domains) {
    const sub = subs.get(d); const src: "crawler" | "community" = sub && !rawOf(d) ? "community" : "crawler";
    const why: TrustWhy[] = [];
    const list = (byD.get(d) ?? []).filter((n) => n.created_at >= nowS - SEEN_RULE.windowS);
    const flaggedNotes = list.filter((n) => flagW.has(n.id));
    const perKey = new Map<string, number>(); let real = 0;
    for (const n of list) {
      if (flagW.has(n.id) || strongKeys.has(n.pubkey)) continue;
      if (sub && n.pubkey === sub.submitter) continue;
      const fs = firstSeen.get(n.pubkey) ?? nowS; // unknown first-seen = brand new key (KM-007)
      if (sub && Math.abs(fs - sub.created_at) < SEEN_RULE.sybilWindowS) continue;
      if ((rep.get(n.pubkey) ?? 0) < SUBMIT_LIMITS.reviewRepBelow) continue;
      if (perKey.has(n.pubkey)) continue;
      const others = [...(domsByKey.get(n.pubkey) ?? [])].filter((x) => x !== d).length;
      const isReal = fs <= nowS - SEEN_RULE.realAgeS || others >= SEEN_RULE.realOtherDomains;
      perKey.set(n.pubkey, isReal ? 1 : SEEN_RULE.newKeyWeight); if (isReal) real++;
    }
    const weighted = [...perKey.values()].reduce((a, b) => a + b, 0);
    const share = list.length ? flaggedNotes.length / list.length : 0;
    let seen = weighted >= SEEN_RULE.weighted && real >= SEEN_RULE.realKeys;
    if (seen && share > SEEN_RULE.dropFlaggedShare) { seen = false; why.push({ kind: "basis-notes-flagged", detail: `${flaggedNotes.length} of ${list.length} basis notes are flagged (> 40%)`, ref: `/flags.json?domain=${d}` }); }
    if (seen) why.push({ kind: "shopper-notes", detail: `${perKey.size} distinct unflagged keys (weighted ${weighted}, ${real} real) posted visit-basis notes in 60 days`, ref: `/merchant/${d}#community` });
    const how: string[] = [];
    const pay = (byD.get(d) ?? []).find((n) => n.proof_status?.startsWith("verified") && n.proof_status !== "verified-preimage" /* K10-001: owner can mint these */ && !flagW.has(n.id) && !strongKeys.has(n.pubkey) && n.pubkey !== sub?.submitter);
    if (pay) { how.push("payment proof: verified 422"); why.push({ kind: "payment-proof", ref: pay.id, detail: "a 422 with a verified payment proof from an unflagged key that is not the submitter" }); }
    const claimKey = [...claims].find((c) => c.startsWith(d + "|"));
    if (claimKey) { how.push("store claim: NIP-05"); why.push({ kind: "store-claim", ref: claimKey.split("|")[1], detail: "a key verified by NIP-05 on this domain signed its own 31420 record" }); }
    const raw = rawOf(d) as { ucp?: { present?: boolean; endpoint?: string | null; src?: string; checked_at?: string }; an_402?: { result?: string; http?: number | null; proto?: string | null; endpoint?: string | null; challenge?: string | null } } | null;
    // Only crawler-observed evidence: a valid /.well-known/ucp JSON doc naming an MCP endpoint, or our own unauthenticated probe
    // that got a real HTTP 402 challenge (record an_402 or data/verify-402.agent-native.json). Directory claims never count.
    if (raw?.ucp?.present === true && raw.ucp.endpoint) { how.push("protocol endpoint: UCP"); why.push({ kind: "protocol-endpoint", ref: raw.ucp.src ?? `https://${d}/.well-known/ucp`, detail: `crawler fetched /.well-known/ucp (robots-first) on ${raw.ucp.checked_at ?? "?"}: a UCP document naming MCP endpoint ${raw.ucp.endpoint}` }); }
    const rp = raw?.an_402?.result === "verified-402" && raw.an_402.http === 402 ? raw.an_402 : PROBE_BY_D.get(d) ?? null;
    if (rp) { how.push(`protocol endpoint: ${rp.proto ?? "402"} challenge`); why.push({ kind: "protocol-endpoint", ref: rp.endpoint ?? d, detail: `our probe got HTTP 402 with ${rp.challenge ?? "a payment challenge"} (${rp.proto ?? "402"}); never paid` }); }
    const dc = dnsClaims.get(d);
    if (dc) { how.push("store claim: DNS TXT"); why.push({ kind: "store-claim", ref: dc, detail: `_klickymart.${d} TXT names this key, and the key signed the claim` }); }
    const sflags = sub?.flags ?? [];
    let tier: Tier = how.length ? "verified" : seen ? "seen" : "unverified";
    if (isTierFlagged(sflags) && !how.some((h) => h.startsWith("store claim"))) { tier = "flagged"; for (const f of sflags.filter((x) => x.strength === "strong")) why.unshift({ kind: f.flag, detail: f.detail }); }
    if (!why.length) why.push({ kind: src === "community" ? "community-submitted" : "crawler-indexed", detail: src === "community" ? "submitted by the community; facts come from the gated crawl only" : "indexed by the KlickyMart crawler; no shopper basis notes yet" });
    out.set(d, { trust_tier: tier, trust_proofs: how, trust_label: tierLabel(tier, { src, flags: sflags, n: list.length - flaggedNotes.length, how }), trust_why: why, src,
      ...(sub ? { submitted_by: sub.submitter_kind === "anon" ? "anonymous" : sub.submitter, submitted_at: new Date(sub.created_at * 1000).toISOString() } : {}),
      seen: { weighted, keys: perKey.size, real_keys: real, basis_notes: list.length, flagged_notes: flaggedNotes.length }, trust_ts: new Date(now).toISOString() });
  }
  if (!opts.skipRep) CACHE = { at: now, key, map: out };
  return out;
}

export function meetsMinTrust(t: Tier | undefined, min: string | null): boolean {
  if (!min) return true;
  const m = (TIERS as readonly string[]).includes(min) ? TIER_RANK[min as Tier] : 0;
  return TIER_RANK[t ?? "unverified"] >= m;
}

export async function getSubmission(db: D1Database | undefined, id: string, origin: string) {
  if (!db) return null;
  try {
    const r = await db.prepare("SELECT id, domain, category, note, evidence_url, via, submitter_kind, submitter, status, reason, flags_json, review, created_at FROM store_submissions WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!r) return null;
    const q = await db.prepare("SELECT state, submissions, queued_at, crawl_note FROM crawl_queue WHERE domain = ?").bind(r.domain).first<Record<string, unknown>>();
    const t = (await computeTrustTiers(db, [String(r.domain)], () => null, Date.now(), { noCache: true })).get(String(r.domain));
    return { id: r.id, domain: r.domain, status: r.status, reason: r.reason, category_hint: r.category, note: r.note, evidence_url: r.evidence_url, via: r.via,
      submitted_by: r.submitter_kind === "anon" ? "anonymous" : r.submitter, submitted_at: new Date(Number(r.created_at) * 1000).toISOString(), flags: JSON.parse(String(r.flags_json)),
      crawl: q ? { state: q.state, submissions: q.submissions, note: q.crawl_note ?? null } : null, trust_tier: t?.trust_tier, trust_label: t?.trust_label, trust_why: t?.trust_why, check: `${origin}/check?domain=${r.domain}` };
  } catch { return null; }
}

/** Export for the box crawler: pending (and optionally review) domains. Public data only (no IP hashes, no submitter ids). */
export async function exportQueue(db: D1Database | undefined, opts: { state?: string; since?: number; limit?: number } = {}) {
  if (!db) return [];
  try {
    const st = opts.state ?? "pending";
    return ((await db.prepare("SELECT domain, first_submission_id, category_hint, submissions, state, flags_json, queued_at FROM crawl_queue WHERE state = ? AND queued_at >= ? ORDER BY queued_at ASC LIMIT ?").bind(st, opts.since ?? 0, Math.min(opts.limit ?? 500, 2000)).all<{ domain: string; first_submission_id: string; category_hint: string | null; submissions: number; state: string; flags_json: string; queued_at: number }>()).results ?? [])
      .map((r) => ({ id: r.first_submission_id, domain: r.domain, category_hint: r.category_hint, submissions: r.submissions, state: r.state, flags: (JSON.parse(r.flags_json) as SubmitFlag[]).map((f) => f.flag), queued_at: new Date(r.queued_at * 1000).toISOString(), src: "community", gate: "crawler/gate.py: tos.py then crawl.py --require-tos; robots.txt first, error/403 = disallow" }));
  } catch { return []; }
}

export async function queuedStatus(db: D1Database | undefined, domain: string): Promise<{ queued: boolean; state?: string; submission?: string } > {
  if (!db) return { queued: false };
  try { const r = await db.prepare("SELECT state, first_submission_id FROM crawl_queue WHERE domain = ?").bind(registrable(domain.toLowerCase().replace(/^www\./, ""))).first<{ state: string; first_submission_id: string }>(); return r ? { queued: true, state: r.state, submission: r.first_submission_id } : { queued: false }; } catch { return { queued: false }; }
}

const BADGE: Record<Tier, string> = { flagged: "#6b7280", unverified: "#a16207", seen: "#1d4ed8", verified: "#15803d" };
const escH = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Small tier badge for HTML pages (inline style; the CSP allows inline styles). */
export function tierBadgeHtml(t: TrustInfo | undefined): string {
  if (!t) return "";
  const why = t.trust_why.map((w) => escH(w.detail)).join("; ");
  return `<p class="km-trust-tier" data-trust-tier="${t.trust_tier}"><span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:${BADGE[t.trust_tier]}" title="${why}">${escH(t.trust_label)}</span> <a href="/llms.txt#trust" style="font-size:12px">trust ladder</a>${t.submitted_by ? ` <small>submitted by ${escH(t.submitted_by === "anonymous" ? "an anonymous agent" : t.submitted_by.slice(0, 16) + "…")} on ${escH(t.submitted_at?.slice(0, 10) ?? "")}</small>` : ""}</p>`;
}
export const TRUST_SCOPE_NOTE = "trust_tier 'verified' means ONE of: a crawler-observed protocol endpoint (UCP or a real HTTP 402), a store ownership claim (DNS TXT or NIP-05), or a verified payment proof. It says nothing about fulfillment or merchant legitimacy: anyone can own a domain and run a protocol endpoint. See trust_dimensions.";
/**
 * Separate the trust dimensions so 'verified' is not read as 'legitimate'. Non-breaking: trust_tier/label unchanged.
 * checkout_accessible is filled by /check from the verdict and probe; merchant_legitimacy is never asserted by KlickyMart.
 */
export function trustDimensions(t: TrustInfo | undefined) {
  const kinds = new Set((t?.trust_why ?? []).map((w) => w.kind));
  const proofs = t?.trust_proofs ?? [];
  return {
    protocol_verified: proofs.some((p) => p.startsWith("protocol endpoint")) || kinds.has("protocol-endpoint"),
    ownership_verified: proofs.some((p) => p.startsWith("store claim")) || kinds.has("store-claim"),
    payment_proof: proofs.some((p) => p.startsWith("payment proof")) || kinds.has("payment-proof"),
    checkout_accessible: null as boolean | null,
    merchant_legitimacy: "not-assessed" as const,
  };
}
export function tierFields(t: TrustInfo | undefined) {
  return { ...tierFieldsBase(t), trust_dimensions: trustDimensions(t) };
}
function tierFieldsBase(t: TrustInfo | undefined) {
  return t ? { trust_tier: t.trust_tier, trust_proofs: t.trust_proofs, trust_label: t.trust_label, trust_why: t.trust_why, src: t.src, ...(t.submitted_by ? { submitted_by: t.submitted_by, submitted_at: t.submitted_at } : {}) } : { trust_tier: "unverified" as Tier, trust_label: "Unverified · crawler-indexed", trust_why: [], src: "crawler" as const };
}

/** Box crawler reports the gated-crawl outcome for a queued submission (behind INGEST_TOKEN). */
export async function setQueueStatus(db: D1Database | undefined, id: string, status: unknown, reason: unknown, dryRun = false): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!db) return { status: 503, body: { ok: false, error: { code: "storage_error", message: "queue not ready" } } };
  if (status !== "crawled" && status !== "refused" && status !== "error") return { status: 400, body: { ok: false, error: { code: "bad_status", message: "status must be crawled | refused | error" } } };
  const why = typeof reason === "string" ? reason.replace(/[\u0000-\u001f]/g, " ").slice(0, 300) : null;
  const sub = await db.prepare("SELECT domain FROM store_submissions WHERE id = ?").bind(id).first<{ domain: string }>();
  const q = sub ? await db.prepare("SELECT domain, state FROM crawl_queue WHERE domain = ?").bind(sub.domain).first<{ domain: string; state: string }>() : null;
  if (!q) return { status: 404, body: { ok: false, error: { code: "not_found", message: "no queued domain for that submission id" } } };
  if (!dryRun) { await db.prepare("UPDATE crawl_queue SET state = ?, crawl_note = ?, updated_at = ? WHERE domain = ?").bind(status, why, Math.floor(Date.now() / 1000), q.domain).run(); clearTierCache(); }
  return { status: 200, body: { ok: true, id, domain: q.domain, previous: q.state, state: status, reason: why, dry_run: dryRun } };
}
