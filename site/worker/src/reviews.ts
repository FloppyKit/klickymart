/** Kind 422 merchant reviews: validation, storage (D1), and reads. Reviews are signed claims, not verified by KlickyMart
 * unless they reference a 421 and carry a payment proof (and even then only the proof is checkable, not the opinion). */
import { NOSTR_KIND_ACCEPTANCE, NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";
import type { NostrEventLine } from "./nostr-record-source";
import { verifyNostrEvent } from "./nostr-verify";
import { utcDay } from "./agent-visits";

export const REVIEW_ATTEMPTS = ["browse", "cart", "checkout", "paid"] as const;
export const REVIEW_LIMITS = { perPubkeyPerDay: 5, perPubkeyPerDomainPerDay: 1, globalPerDay: 1000, maxContent: 2000, maxFutureS: 600, maxAgeS: 7 * 86400, maxBytes: 16384 };

export interface ParsedReview {
  id: string; d: string; pubkey: string; created_at: number; rating: number; rating_max: number;
  attempt: (typeof REVIEW_ATTEMPTS)[number]; pay: string | null; fulfillment: string | null; proof: string | null; content: string;
}

type Res<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });
const tag = (tags: string[][], name: string) => tags.find((t) => t[0] === name);

/** Schema + signature check. `knownDomain` says whether the merchant is in the index. */
export function parseReviewEvent(input: unknown, knownDomain: (d: string) => boolean, now = Date.now()): Res<ParsedReview> {
  if (!input || typeof input !== "object") return fail("bad_event", "body must be a signed Nostr event JSON object");
  const ev = input as NostrEventLine & Record<string, unknown>;
  if ("nsec" in ev || "privkey" in ev || "seckey" in ev) return fail("secret_sent", "never send a secret key; sign locally and send only the signed event");
  const v = verifyNostrEvent(ev, NOSTR_KIND_ACCEPTANCE);
  if (!v.ok) return fail("bad_signature", v.reason);
  const tags = ev.tags as string[][];
  if (!tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return fail("bad_tags", "tags must be arrays of strings");
  const nowS = Math.floor(now / 1000);
  const ca = ev.created_at as number;
  if (ca > nowS + REVIEW_LIMITS.maxFutureS) return fail("bad_time", "created_at is in the future");
  if (ca < nowS - REVIEW_LIMITS.maxAgeS) return fail("bad_time", "created_at older than 7 days; publish to relays instead");
  const a = tag(tags, "a");
  const m = a?.[1]?.match(new RegExp(`^${NOSTR_KIND_CRAWL_RECORD}:([0-9a-f]{64}):([a-z0-9.-]+)$`));
  if (!m) return fail("missing_a", `review needs ["a","${NOSTR_KIND_CRAWL_RECORD}:<record-author-pubkey>:<domain>"]`);
  const d = m[2]!;
  if (!knownDomain(d)) return fail("unknown_domain", `${d} is not in the index`);
  const r = tag(tags, "rating");
  const rating = Number(r?.[1]); const rmax = Number(r?.[2] ?? "5");
  if (!r || !Number.isInteger(rating) || !Number.isInteger(rmax) || rmax < 1 || rmax > 10 || rating < 0 || rating > rmax) {
    return fail("bad_rating", 'need ["rating","<0..max>","<max, default 5>"]');
  }
  const att = tag(tags, "attempt")?.[1];
  if (!att || !(REVIEW_ATTEMPTS as readonly string[]).includes(att)) return fail("bad_attempt", `need ["attempt", one of ${REVIEW_ATTEMPTS.join("|")}]`);
  const pay = tag(tags, "pay")?.[1] ?? null;
  if (pay !== null && !/^[a-z0-9:_-]{1,40}$/.test(pay)) return fail("bad_pay", "pay must be a short payment code, e.g. lightning");
  const ful = tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1] ?? null;
  if (ful !== null && !/^[0-9a-f]{64}$/.test(ful)) return fail("bad_e", "fulfillment e tag must be a 64-hex event id");
  const proof = tag(tags, "zap") ? "zap" : tag(tags, "preimage") ? "preimage" : tag(tags, "cashu") ? "cashu" : null;
  const content = ev.content as string;
  if (content.length > REVIEW_LIMITS.maxContent) return fail("too_long", `content over ${REVIEW_LIMITS.maxContent} chars`);
  return { ok: true, value: { id: ev.id!.toLowerCase(), d, pubkey: ev.pubkey!.toLowerCase(), created_at: ca, rating, rating_max: rmax, attempt: att as ParsedReview["attempt"], pay, fulfillment: ful, proof, content } };
}

/** Rate limits by pubkey and globally (no IPs). Returns null if allowed. */
export async function rateLimitCheck(db: D1Database, rv: ParsedReview, now = Date.now()): Promise<{ code: string; message: string } | null> {
  const day = utcDay(now);
  const g = await db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE received_day = ?").bind(day).first<{ n: number }>();
  if ((g?.n ?? 0) >= REVIEW_LIMITS.globalPerDay) return { code: "rate_limited", message: "daily review intake is full; publish to relays and try tomorrow" };
  const p = await db.prepare("SELECT COUNT(*) AS n, SUM(d = ?) AS nd FROM reviews WHERE pubkey = ? AND received_day = ?").bind(rv.d, rv.pubkey, day).first<{ n: number; nd: number | null }>();
  if ((p?.n ?? 0) >= REVIEW_LIMITS.perPubkeyPerDay) return { code: "rate_limited", message: `max ${REVIEW_LIMITS.perPubkeyPerDay} reviews per key per day` };
  if ((p?.nd ?? 0) >= REVIEW_LIMITS.perPubkeyPerDomainPerDay) return { code: "rate_limited", message: "one review per key per merchant per day" };
  return null;
}

export async function storeReview(db: D1Database, rv: ParsedReview, raw: unknown, now = Date.now()): Promise<"stored" | "duplicate"> {
  const r = await db.prepare(
    "INSERT OR IGNORE INTO reviews (id,d,pubkey,created_at,rating,rating_max,attempt,pay,fulfillment,proof,content,raw_json,received_day) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(rv.id, rv.d, rv.pubkey, rv.created_at, rv.rating, rv.rating_max, rv.attempt, rv.pay, rv.fulfillment, rv.proof, rv.content, JSON.stringify(raw), utcDay(now)).run();
  return (r.meta?.changes ?? 0) > 0 ? "stored" : "duplicate";
}

export interface ReviewSummary { count: number; avg_rating_5: number | null; items: (ParsedReview & { verified: string; event: unknown })[]; note: string }

export const REVIEW_NOTE = "Reviews are signed claims by pseudonymous keys. KlickyMart checks the signature and format only; it does not verify the opinion. A review that references a 421 and carries a payment proof (zap/preimage/cashu) is marked proof-attached, not proof-verified.";

export async function getReviews(db: D1Database | undefined, d: string, limit = 20): Promise<ReviewSummary> {
  const out: ReviewSummary = { count: 0, avg_rating_5: null, items: [], note: REVIEW_NOTE };
  if (!db) return out;
  try {
    const agg = await db.prepare("SELECT COUNT(*) AS n, AVG(rating * 5.0 / rating_max) AS a FROM reviews WHERE d = ?").bind(d).first<{ n: number; a: number | null }>();
    out.count = agg?.n ?? 0;
    out.avg_rating_5 = agg?.a == null ? null : Math.round(agg.a * 10) / 10;
    const { results } = await db.prepare("SELECT id,d,pubkey,created_at,rating,rating_max,attempt,pay,fulfillment,proof,content,raw_json FROM reviews WHERE d = ? ORDER BY created_at DESC LIMIT ?").bind(d, Math.min(100, limit)).all<ParsedReview & { raw_json: string }>();
    out.items = (results ?? []).map(({ raw_json, ...r }) => ({ ...r, verified: r.fulfillment && r.proof ? "signature-ok, proof-attached (not verified)" : "signature-ok (claim)", event: JSON.parse(raw_json) }));
  } catch {
    /* migration pending */
  }
  return out;
}
