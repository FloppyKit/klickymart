import { countsForRank, keyFirstSeen, MIN_RANK_KEY_AGE_S } from "./key-age";
import { claimedKeys, storeBindings } from "./pay-binding";
import { flagSummary, readFlagCache, type NoteFlag } from "./flags";
import { loadTips, summarize, type Tip, type TipSummary } from "./tips";
/** Structured shopping-experience notes on kind 422 (spec: NIP-DRAFT.md "422 as a shopping experience"), plus
 * unstructured kind-1 notes tagged #klickymart. Parsing, storage, per-store aggregates and unsigned templates.
 * KlickyMart never signs or publishes on anyone's behalf; it caches public notes and shows them next to crawl data. */
import { NOSTR_KIND_ACCEPTANCE, NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";
import { verifyNostrEvent } from "./nostr-verify";
import { utcDay } from "./agent-visits";
import { canonPay, isPayCode } from "./vocab";

/** Depth stages, aligned with the checkout-map stages (home/category -> browse, product, cart, checkout, shipform -> shipping, paypage -> payment). */
export const EXP_DEPTHS = ["browse", "product", "cart", "checkout", "shipping", "payment", "paid", "delivered"] as const;
/** Checkout-map stage names and legacy names accepted as depth aliases (with a warning). */
export const DEPTH_ALIASES: Record<string, string> = { home: "browse", category: "browse", shop: "browse", sitemap: "browse", price_tile: "product", add_to_cart: "cart", cart_reload: "cart", checkout_click: "checkout", checkout_direct: "checkout", continue: "checkout", shipform: "shipping", paypage: "payment", bought: "paid" };
export function canonDepth(v: string | undefined): { depth: string | null; alias: boolean; bad: boolean } {
  if (!v) return { depth: null, alias: false, bad: false };
  const k = v.trim().toLowerCase();
  if ((EXP_DEPTHS as readonly string[]).includes(k)) return { depth: k, alias: false, bad: false };
  if (DEPTH_ALIASES[k]) return { depth: DEPTH_ALIASES[k]!, alias: true, bad: false };
  return { depth: null, alias: false, bad: true };
}
export const EXP_WALLS = ["captcha", "login", "bot-wall", "geo", "age-gate", "phone-verify", "none"] as const;
export const EXP_BTC_ROUTES = ["native", "indirect"] as const;
export const PROOF_TAGS = ["zap", "preimage", "cashu", "order_hash"] as const;
export const KIND_NOTE = 1;
/** basis: visit = the agent went to the store itself; directory = written from KlickyMart data; secondhand = relayed from someone else's account. Only "visit" counts toward aggregates. */
export const EXP_BASIS = ["visit", "directory", "secondhand", "unknown"] as const;
/** Amount kinds: price (the item price you saw; alias of price_seen), price_seen, price_paid, fee, shipping, tax, total.
 * A 5th element "estimated" marks an amount you estimated rather than saw at checkout. */
export const AMOUNT_KINDS = ["price", "price_seen", "price_paid", "fee", "shipping", "tax", "total"] as const;
/** shown_before_payment values: true | false | unknown | not-observed (you didn't get far enough, or wrote from directory data). */
export const SBP_VALUES = ["true", "false", "unknown", "not-observed"] as const;
export const NOTE_HASHTAG = "klickymart";
/** Reserved fake domain for KlickyMart's own relay-to-chart ingest self-tests (RFC 2606 .invalid: never a real store).
 * Notes about it are accepted and aggregated, but listed apart from the ranked chart. */
export const SELFTEST_DOMAIN = "klickymart-selftest.invalid";
/** Experience tag names, documented in llms.txt / NIP-DRAFT. All optional except the store reference. */
export const EXP_TAGS = ["a", "r", "product", "gtin", "depth", "step", "steps", "blocker", "wall", "guest", "account_required", "pay_used", "pay_offered", "btc_route",
  "shown_before_payment", "amount", "region", "duration_s", "agent", "delivered", "rating", "attempt", "basis", "t", "L", "l", "e", "p", "pay", "fulfillment", "lud16", "shipping_source", "price_source", ...PROOF_TAGS] as const;

export interface Experience {
  id: string; kind: number; d: string; pubkey: string; created_at: number; structured: boolean;
  depth: string | null; guest: string | null; account_required: string | null; pay_used: string | null; pay_offered: string[]; btc_route: string | null;
  tax_before: string | null; ship_before: string | null; price: number | null; shipping: number | null; tax: number | null; total: number | null; currency: string | null;
  region: string | null; steps_n: number | null; duration_s: number | null; blocker: string | null; walls: string[]; agent: string | null;
  delivered: string | null; delivery_days: number | null; rating5: number | null; product: string | null; proof: string | null; content: string;
  basis: "visit" | "directory" | "secondhand" | "unknown"; warnings: string[];
}
type Res<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });
const tv = (tags: string[][], n: string) => tags.find((t) => t[0] === n);
const yn = (v: string | undefined) => (v === "yes" || v === "true" ? "yes" : v === "no" || v === "false" ? "no" : null);
/** Tri-state: true|false|unknown (yes|no accepted). null = unknown/absent; "bad" = invalid. */
export const tri = (v: string | undefined): "yes" | "no" | null | "bad" => { if (v === undefined || v === "" || v === "unknown") return null; return yn(v.toLowerCase()) ?? "bad"; };
const num = (v: string | undefined) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : null; };

/** Store reference from ["a","31420:<pk>:<domain>"] or ["r","<domain or url>"]. */
export function expDomain(tags: string[][]): string | null {
  const a = tv(tags, "a")?.[1]?.match(new RegExp(`^${NOSTR_KIND_CRAWL_RECORD}:[0-9a-f]{64}:([a-z0-9.-]+)$`));
  if (a) return a[1]!;
  for (const t of tags) if (t[0] === "r" && t[1]) {
    try { const h = new URL(t[1].includes("://") ? t[1] : `https://${t[1]}`).hostname.toLowerCase().replace(/^www\./, ""); if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return h; } catch { /* */ }
  }
  return null;
}
/** Region must be coarse: a ZIP3 ("660"), a state ("US-KS") or a country ("US"). Full ZIPs or anything address-like is rejected. */
export function coarseRegion(v: string | undefined): Res<string | null> {
  if (!v) return { ok: true, value: null };
  if (/^\d{3}$/.test(v) || /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(v)) return { ok: true, value: v };
  return fail("region_too_precise", "region must be a ZIP3 like 660, a state like US-KS, or a country like US; never a full ZIP or address");
}

export function parseExperience(input: unknown, knownDomain: (d: string) => boolean, now = Date.now(), opts: { maxAgeS?: number } = {}): Res<Experience> {
  if (!input || typeof input !== "object") return fail("bad_event", "body must be a signed Nostr event JSON object");
  const ev = input as { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string } & Record<string, unknown>;
  if ("nsec" in ev || "privkey" in ev || "seckey" in ev) return fail("secret_sent", "never send a secret key; sign locally and send only the signed event");
  if (ev.kind !== NOSTR_KIND_ACCEPTANCE && ev.kind !== KIND_NOTE) return fail("bad_kind", "experience notes are kind 422 (structured) or kind 1 tagged #klickymart (unstructured)");
  const v = verifyNostrEvent(ev as never, ev.kind);
  if (!v.ok) return fail("bad_signature", v.reason);
  const tags = ev.tags;
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"))) return fail("bad_tags", "tags must be arrays of strings");
  const nowS = Math.floor(now / 1000);
  if (ev.created_at > nowS + 600) return fail("bad_time", "created_at is in the future");
  if (ev.created_at < nowS - (opts.maxAgeS ?? 30 * 86400)) return fail("bad_time", "created_at older than 30 days; publish to relays instead");
  if (typeof ev.content !== "string" || ev.content.length > 4000) return fail("too_long", "content over 4000 chars");
  const d = expDomain(tags);
  if (!d) return fail("missing_store", 'need ["a","31420:<record-author>:<domain>"] or ["r","<domain>"]');
  if (!knownDomain(d)) return fail("unknown_domain", `${d} is not in the index`);
  const structured = ev.kind === NOSTR_KIND_ACCEPTANCE;
  if (!structured && !tags.some((t) => t[0] === "t" && t[1]?.toLowerCase() === NOTE_HASHTAG)) return fail("missing_hashtag", 'kind 1 notes need ["t","klickymart"]');
  const warnings: string[] = [];
  const unknownTags = [...new Set(tags.map((t) => t[0]!).filter((n) => !(EXP_TAGS as readonly string[]).includes(n)))];
  if (unknownTags.length) warnings.push(`ignored unknown tags: ${unknownTags.join(", ")}`);
  const flags: Record<string, "yes" | "no" | null> = {};
  for (const k of ["guest", "account_required"]) { const v = tri(tv(tags, k)?.[1]); if (v === "bad") return fail(`bad_${k}`, `["${k}", true|false|unknown] (got "${tv(tags, k)?.[1]}")`); flags[k] = v; }
  const basisT = tv(tags, "basis")?.[1];
  if (basisT && !(EXP_BASIS as readonly string[]).includes(basisT)) return fail("bad_basis", 'basis must be "visit" (you went to the store), "directory" (written from KlickyMart data, no visit), "secondhand" (relayed from someone else) or "unknown"');
  if (structured && !basisT) warnings.push('no ["basis",...] tag: recorded as "unknown", which does not count toward the chart. Add ["basis","visit"] if you went to the store yourself.');
  if (!tv(tags, "depth") && tv(tags, "attempt")) warnings.push('"attempt" is the legacy name; use ["depth",...] (attempt accepted as an alias)');
  const cd = canonDepth(tv(tags, "depth")?.[1] ?? tv(tags, "attempt")?.[1]);
  if (cd.bad) return fail("bad_depth", `depth must be one of ${EXP_DEPTHS.join("|")} (checkout-map stage names like ${Object.keys(DEPTH_ALIASES).slice(0, 6).join(", ")} are accepted as aliases)`);
  if (cd.alias) warnings.push(`depth "${tv(tags, "depth")?.[1] ?? tv(tags, "attempt")?.[1]}" mapped to "${cd.depth}"`);
  const depth = cd.depth;
  const rg = coarseRegion(tv(tags, "region")?.[1]); if (!rg.ok) return rg;
  if (/\b\d{5}(-\d{4})?\b/.test(tags.filter((t) => t[0] === "region").flat().join(" "))) return fail("region_too_precise", "never put a full ZIP in tags");
  const r = tv(tags, "rating"); let rating5: number | null = null;
  if (r) { const n = Number(r[1]), m = Number(r[2] ?? "5"); if (!Number.isFinite(n) || !Number.isFinite(m) || m < 1 || m > 10 || n < 0 || n > m) return fail("bad_rating", 'need ["rating","<0..max>","<max>"]'); rating5 = Math.round((n * 5 / m) * 10) / 10; }
  if (structured && !depth && rating5 === null) return fail("not_an_experience", 'a 422 experience needs at least ["depth",...] or ["rating",...]');
  const amt = (k: string) => { const t = tags.find((x) => x[0] === "amount" && x[1] === k); return t ? { v: num(t[2]), c: t[3] ?? null } : null; };
  for (const t of tags) if (t[0] === "amount" && !(AMOUNT_KINDS as readonly string[]).includes(t[1] ?? "")) warnings.push(`amount "${t[1]}" ignored (use ${AMOUNT_KINDS.join(", ")})`);
  const price = amt("price_paid") ?? amt("price") ?? amt("price_seen"), ship = amt("shipping"), tax = amt("tax"), total = amt("total");
  const sbpNone = tags.some((x) => x[0] === "shown_before_payment" && x[1] === "none");
  const sbp = (k: string) => { const t = tags.find((x) => x[0] === "shown_before_payment" && x[1] === k); if (t) { const v = t[2] === "not-observed" ? null : tri(t[2]); if (v === "bad") warnings.push(`shown_before_payment ${k}: "${t[2]}" is not true|false|unknown; ignored`); return v === "bad" ? null : v; } return sbpNone ? "no" : null; };
  for (const t of tags) if (t[0] === "shown_before_payment" && !["tax", "shipping", "none"].includes(t[1] ?? "")) warnings.push(`shown_before_payment "${t[1]}" ignored (use tax, shipping or none)`);
  const payUsed = tv(tags, "pay_used")?.[1] ?? tv(tags, "pay")?.[1] ?? null;
  const pay_offered = [...new Set(tags.filter((t) => t[0] === "pay_offered").flatMap((t) => t.slice(1)).filter((x) => x !== "none-observed").map((x) => canonPay(x.toLowerCase())).filter((x): x is string => !!x))];
  for (const c of [payUsed, ...tags.filter((t) => t[0] === "pay_offered").flatMap((t) => t.slice(1)).filter((x) => x !== "none-observed")]) if (c && !isPayCode(canonPay(c))) warnings.push(`pay code "${c}" not in /vocab.json pay_codes; kept as given`);
  const br = tv(tags, "btc_route")?.[1] ?? null;
  if (br && !(EXP_BTC_ROUTES as readonly string[]).includes(br)) return fail("bad_btc_route", "btc_route must be native or indirect");
  const steps = tags.filter((t) => t[0] === "step");
  const del = tv(tags, "delivered");
  const proof = (PROOF_TAGS as readonly string[]).find((p) => tv(tags, p)) ?? null;
  if (tv(tags, "order_hash") && !/^[0-9a-f]{64}$/i.test(tv(tags, "order_hash")![1] ?? "")) return fail("bad_order_hash", "order_hash must be a 64-hex sha256 of the order confirmation (never the confirmation itself)");
  return { ok: true, value: {
    id: ev.id.toLowerCase(), kind: ev.kind, d, pubkey: ev.pubkey.toLowerCase(), created_at: ev.created_at, structured,
    depth, guest: flags.guest!, account_required: flags.account_required!,
    pay_used: payUsed ? canonPay(payUsed.toLowerCase()) ?? payUsed.toLowerCase().slice(0, 40) : null, pay_offered, btc_route: br,
    tax_before: sbp("tax"), ship_before: sbp("shipping"), price: price?.v ?? null, shipping: ship?.v ?? null, tax: tax?.v ?? null, total: total?.v ?? null,
    currency: (total?.c ?? price?.c ?? ship?.c ?? tax?.c ?? null)?.toUpperCase().slice(0, 3) ?? null, region: rg.value,
    steps_n: num(tv(tags, "steps")?.[1]) ?? (steps.length || null), duration_s: num(tv(tags, "duration_s")?.[1]),
    blocker: tv(tags, "blocker")?.[1]?.slice(0, 40) ?? null, walls: tags.filter((t) => t[0] === "wall").map((t) => t[1]!).filter((w) => (EXP_WALLS as readonly string[]).includes(w)),
    agent: tv(tags, "agent")?.[1]?.slice(0, 60) ?? null, delivered: del ? yn(del[1]) : null, delivery_days: del ? num(del[2]) : null,
    basis: (basisT as Experience["basis"] | undefined) ?? "unknown", warnings, rating5, product: (tv(tags, "product")?.[1] ?? (tv(tags, "gtin") ? `gtin:${tv(tags, "gtin")![1]}` : null))?.slice(0, 300) ?? null, proof, content: ev.content,
  } };
}

export async function storeExperience(db: D1Database, x: Experience, raw: unknown, src: { source: "post" | "relay"; relays?: string | null; proof_status?: string | null }, now = Date.now()) {
  const r = await db.prepare(`INSERT OR IGNORE INTO experiences (id,kind,d,pubkey,created_at,structured,depth,guest,account_required,pay_used,pay_offered,btc_route,tax_before,ship_before,price,shipping,tax,total,currency,region,steps_n,duration_s,blocker,walls,agent,delivered,delivery_days,rating5,product,proof,proof_status,content,raw_json,source,relays,received_day,basis)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    x.id, x.kind, x.d, x.pubkey, x.created_at, x.structured ? 1 : 0, x.depth, x.guest, x.account_required, x.pay_used, JSON.stringify(x.pay_offered), x.btc_route, x.tax_before, x.ship_before,
    x.price, x.shipping, x.tax, x.total, x.currency, x.region, x.steps_n, x.duration_s, x.blocker, JSON.stringify(x.walls), x.agent, x.delivered, x.delivery_days, x.rating5, x.product, x.proof,
    src.proof_status ?? (x.proof ? "proof-attached" : null), x.content, JSON.stringify(raw), src.source, src.relays ?? null, utcDay(now), x.basis ?? "visit").run();
  return (r.meta?.changes ?? 0) > 0 ? "stored" : "duplicate";
}

export const MIN_KEYS = 2;
const DEPTH_RANK: Record<string, number> = { browse: 0, product: 0.5, cart: 1, checkout: 2, shipping: 2.5, payment: 3, paid: 4, delivered: 5 };
/** Weight of one key's evidence: 1 by default, 2 with a proof attached, 3 when the proof was checked. */
/** K10-001: verified-preimage is evidence of a binding to the store's own node, NOT of a third-party payment (the owner knows
 * every preimage), so it weighs the same as a plain note (1) and does not count as a purchase proof. */
// K10-001 follow-up: verified-zap is demoted too. The receipt is signed by the store's own declared LNURL server, which the
// owner can run and use to mint a receipt for a zap nobody paid. No proof_status currently counts as a purchase proof.
export const NO_PURCHASE_PROOF = new Set(["facilitated-history", "facilitated-unverified", "replayed-proof", "verified-preimage", "verified-zap"]);
/** R12-101: an unchecked proof tag (cashu, order_hash, "proof-attached", "unverified-claim") is just text the author typed,
 * so it weighs like a plain note (1). Only a status in CHECKED_PURCHASE_PROOF weighs 3; that set is empty today because
 * no proof type is independently checked (see K10-001), so every note weighs 1. */
export const CHECKED_PURCHASE_PROOF = new Set<string>();
export const proofWeight = (_proof: string | null, status: string | null) => (status && CHECKED_PURCHASE_PROOF.has(status) && !NO_PURCHASE_PROOF.has(status) ? 3 : 1);
type Row = Experience & { proof_status: string | null; walls_json?: string };

export interface StoreAggregate {
  d: string; source: "community"; notes: number; structured_notes: number; unstructured_notes: number; keys: number; corroborated: boolean;
  depth: Record<string, number>; reached_checkout_keys: number; paid_keys: number; success_score: number | null;
  blockers: { kind: string; keys: number }[]; walls: { kind: string; keys: number }[];
  pay_used: { pay: string; keys: number; corroborated: boolean }[];
  guest_yes_keys: number; guest_no_keys: number; account_required_keys: number;
  tax_before: { yes: number; no: number }; ship_before: { yes: number; no: number };
  observed: { shipping_usd: { median: number | null; n: number; keys: number; corroborated: boolean }; tax_rate_pct: { median: number | null; n: number; keys: number; corroborated: boolean } };
  verified_purchase_share: number; proof_keys: number; tips: TipSummary; flags: ReturnType<typeof flagSummary>; directory_notes_excluded?: number; owner_notes_excluded?: number; young_key_notes_excluded?: number; avg_rating_5: number | null; latest_at: number | null; notes_30d: number; rules: string;
}
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 100) / 100; };

/** Aggregate one store's notes. Counts are distinct pubkeys (each key's latest structured note; any proof from a key counts once). */
export function aggregate(d: string, rows: Row[], now = Date.now(), tips?: Map<string, Tip[]>, flags?: Map<string, NoteFlag>): StoreAggregate {
  const nowS = Math.floor(now / 1000);
  const sorted = [...rows].sort((a, b) => b.created_at - a.created_at);
  const latest = new Map<string, Row>();
  for (const r of sorted) if (r.structured && !latest.has(r.pubkey)) latest.set(r.pubkey, r);
  const per = [...latest.values()];
  const keysAll = new Set(rows.map((r) => r.pubkey));
  const proofKeys = new Set(rows.filter((r) => !!r.proof_status && CHECKED_PURCHASE_PROOF.has(r.proof_status) && !NO_PURCHASE_PROOF.has(r.proof_status)).map((r) => r.pubkey));
  const wOf = new Map<string, number>(); for (const r of rows) wOf.set(r.pubkey, Math.max(wOf.get(r.pubkey) ?? 1, proofWeight(r.proof, r.proof_status) * (flags?.get(r.id)?.tip_weight ?? (tips ? summarize(tips.get(r.id) ?? []).weight : 1)) * (flags?.get(r.id)?.weight ?? 1)));
  const noteFlags = rows.map((r) => flags?.get(r.id)).filter((x): x is NoteFlag => !!x);
  const storeTips = summarize(rows.flatMap((r) => tips?.get(r.id) ?? []));
  const depth: Record<string, number> = Object.fromEntries(EXP_DEPTHS.map((x) => [x, 0]));
  for (const r of per) if (r.depth) depth[r.depth] = (depth[r.depth] ?? 0) + 1;
  const count = (f: (r: Row) => string | string[] | null) => { const m = new Map<string, Set<string>>(); for (const r of per) { const v = f(r); for (const k of Array.isArray(v) ? v : v ? [v] : []) { const s = m.get(k) ?? new Set(); s.add(r.pubkey); m.set(k, s); } } return [...m.entries()].map(([kind, s]) => ({ kind, keys: s.size })).sort((a, b) => b.keys - a.keys); };
  const reached = per.filter((r) => r.depth && DEPTH_RANK[r.depth]! >= 2);
  const paid = per.filter((r) => r.depth && DEPTH_RANK[r.depth]! >= 4);
  // weighted share of keys that reached payment or beyond; null until 2 keys
  // a key whose notes here are all zero-weighted by flags drops out of the score entirely
  const wsum = per.reduce((a, r) => a + (wOf.get(r.pubkey) ?? 1), 0);
  const wok = per.filter((r) => r.depth && DEPTH_RANK[r.depth]! >= 3).reduce((a, r) => a + (wOf.get(r.pubkey) ?? 1), 0);
  const ships = per.filter((r) => r.shipping !== null && (r.currency ?? "USD") === "USD");
  const taxes = per.filter((r) => r.tax !== null && r.price && r.price > 0);
  const rated = per.filter((r) => r.rating5 !== null);
  return {
    d, source: "community", notes: rows.length, structured_notes: rows.filter((r) => r.structured).length, unstructured_notes: rows.filter((r) => !r.structured).length,
    keys: keysAll.size, corroborated: per.length >= MIN_KEYS,
    depth, reached_checkout_keys: reached.length, paid_keys: paid.length, success_score: per.length >= MIN_KEYS && wsum ? Math.round((wok / wsum) * 100) / 100 : null,
    blockers: count((r) => r.blocker), walls: count((r) => r.walls.filter((w) => w !== "none")),
    pay_used: count((r) => r.pay_used).map((x) => ({ pay: x.kind, keys: x.keys, corroborated: x.keys >= MIN_KEYS })),
    guest_yes_keys: per.filter((r) => r.guest === "yes").length, guest_no_keys: per.filter((r) => r.guest === "no").length, account_required_keys: per.filter((r) => r.account_required === "yes").length,
    tax_before: { yes: per.filter((r) => r.tax_before === "yes").length, no: per.filter((r) => r.tax_before === "no").length },
    ship_before: { yes: per.filter((r) => r.ship_before === "yes").length, no: per.filter((r) => r.ship_before === "no").length },
    observed: {
      shipping_usd: { median: med(ships.map((r) => r.shipping!)), n: ships.length, keys: new Set(ships.map((r) => r.pubkey)).size, corroborated: new Set(ships.map((r) => r.pubkey)).size >= MIN_KEYS },
      tax_rate_pct: { median: med(taxes.map((r) => Math.round((r.tax! / r.price!) * 10000) / 100)), n: taxes.length, keys: new Set(taxes.map((r) => r.pubkey)).size, corroborated: new Set(taxes.map((r) => r.pubkey)).size >= MIN_KEYS },
    },
    verified_purchase_share: keysAll.size ? Math.round((proofKeys.size / keysAll.size) * 100) / 100 : 0, proof_keys: proofKeys.size,
    tips: storeTips, flags: flagSummary(noteFlags),
    avg_rating_5: rated.length ? Math.round((rated.reduce((a, r) => a + r.rating5!, 0) / rated.length) * 10) / 10 : null,
    latest_at: sorted[0]?.created_at ?? null, notes_30d: rows.filter((r) => r.created_at >= nowS - 30 * 86400).length,
    rules: `Distinct keys; each key's latest structured note counts once. ${MIN_KEYS}+ keys before a value is 'corroborated'. Every note weighs 1: unchecked proof tags (cashu, order_hash) are not checked, and verified-preimage and verified-zap weigh 1 like a plain note (the store owner can mint both without anyone paying), and no proof type currently counts as a purchase proof; every key must pass the 7-day key-age gate whatever its proof, and the store owner's own keys never count; a key's weight is multiplied by 1 + min(0.5, 0.1 x distinct validated tippers) on its notes (self-zaps ignored). Unstructured kind-1 notes count toward 'notes' only. Keys count only once KlickyMart has seen them for 7+ days (ingest time, not created_at); no proof exempts a key. Crawl data is never overwritten.`,
  };
}

const COLS = "id,kind,d,pubkey,created_at,structured,depth,guest,account_required,pay_used,pay_offered,btc_route,tax_before,ship_before,price,shipping,tax,total,currency,region,steps_n,duration_s,blocker,walls,agent,delivered,delivery_days,rating5,product,proof,proof_status,content,basis";
const fromDb = (r: Record<string, any>): Row => ({ ...r, structured: r.structured === 1, pay_offered: JSON.parse(r.pay_offered || "[]"), walls: JSON.parse(r.walls || "[]") }) as Row;
export async function loadAggregates(db: D1Database | undefined, domains?: string[], now = Date.now(), opts: { inStoreOnly?: Set<string>; minKeyAgeS?: number } = {}): Promise<Map<string, StoreAggregate>> {
  const out = new Map<string, StoreAggregate>();
  if (!db) return out;
  try {
    const q = domains?.length ? `SELECT ${COLS} FROM experiences WHERE d IN (${domains.map(() => "?").join(",")})` : `SELECT ${COLS} FROM experiences`;
    const { results } = await db.prepare(q).bind(...(domains ?? [])).all<Record<string, any>>();
    const tips = (await loadTips(db)).byNote;
    const flags = await readFlagCache(db); // computed on write (refreshFlagCache)
    const by = new Map<string, Row[]>();
    for (const r of results ?? []) { const x = fromDb(r); const l = by.get(x.d) ?? []; l.push(x); by.set(x.d, l); }
    // Directory-based and second-hand notes never count toward aggregates or corroboration.
    // KM-007: notes from keys younger than MIN_RANK_KEY_AGE_S by ingest time don't count; no proof exempts a key (K10-001).
    const seen = await keyFirstSeen(db); const nowS = Math.floor(now / 1000); const minAge = opts.minKeyAgeS ?? MIN_RANK_KEY_AGE_S;
    for (const [d, rows] of by) {
      // K10-001(c): the store's own declared keys (claimants, and zap_pubkey keys in the owner's 31420) never count for rank.
      const owners = await ownerKeys(db, d);
      const visit = rows.filter((r) => (r.basis ?? "visit") === "visit" && !owners.has(r.pubkey)); const aged = visit.filter((r) => countsForRank(r.pubkey, r.proof_status, seen, nowS, minAge));
      if (!aged.length) continue; const a = aggregate(d, aged, now, tips, flags); a.directory_notes_excluded = rows.filter((r) => (r.basis ?? "visit") !== "visit").length; a.owner_notes_excluded = rows.filter((r) => owners.has(r.pubkey)).length; a.young_key_notes_excluded = visit.length - aged.length; out.set(d, a);
    }
  } catch { /* migration pending */ }
  return out;
}

/** Unsigned event template for the agent to sign and publish itself. */
export const TEMPLATE_PARAMS = ["domain", "depth", "attempt", "basis", "product", "product_url", "gtin", "steps", "steps_n", "blocker", "walls", "guest", "account_required", "pay_used", "pay_offered", "btc_route",
  "shown_before_payment", "tax_shown_before_payment", "shipping_shown_before_payment", "price", "shipping", "tax", "total", "currency", "region", "duration_s", "agent", "delivered", "delivery_days", "rating", "rating_max", "narrative", "lud16", ...PROOF_TAGS] as const;
export const TEMPLATE_EXTRA = ["price_seen", "price_paid", "fee", "estimated", "shipping_source", "price_source", "strict"] as const;
const REVIEW_ATTEMPT_OF: Record<string, string> = { browse: "browse", product: "browse", cart: "cart", checkout: "checkout", shipping: "checkout", payment: "checkout", paid: "paid", delivered: "paid" };
export function experienceTemplate(a: Record<string, unknown>, aTag: string | null, nowS = Math.floor(Date.now() / 1000)): Res<Record<string, unknown>> {
  const s = (k: string) => (a[k] === undefined || a[k] === null || a[k] === "" ? undefined : String(a[k]));
  const list = (k: string) => (Array.isArray(a[k]) ? (a[k] as unknown[]).map(String) : s(k)?.split(",").map((x) => x.trim()).filter(Boolean) ?? []);
  const warnings: string[] = [];
  const known = [...TEMPLATE_PARAMS, ...TEMPLATE_EXTRA] as readonly string[];
  const unknown = Object.keys(a).filter((k) => !known.includes(k));
  const strictMode = a.strict === true || /^(1|true)$/i.test(String(a.strict ?? ""));
  if (unknown.length && strictMode) return fail("unknown_field", `strict=1: unknown fields ${unknown.join(", ")} (known: ${known.join(", ")})`);
  if (unknown.length) warnings.push(`ignored unknown fields: ${unknown.join(", ")} (known: ${known.join(", ")})`);
  const d = s("domain")?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!d) return fail("missing_domain", "domain is required");
  if (!s("depth") && s("attempt")) warnings.push('"attempt" is the legacy name; use depth (accepted as an alias)');
  const cd = canonDepth(s("depth") ?? s("attempt"));
  if (cd.bad) return fail("bad_depth", `depth must be one of ${EXP_DEPTHS.join("|")} (checkout-map stage names like home, add_to_cart, shipform, paypage are accepted as aliases)`);
  if (cd.alias) warnings.push(`depth "${s("depth") ?? s("attempt")}" mapped to "${cd.depth}"`);
  const depth = cd.depth ?? undefined;
  const basis = s("basis");
  if (basis && !(EXP_BASIS as readonly string[]).includes(basis)) return fail("bad_basis", `basis must be one of ${EXP_BASIS.join("|")}`);
  if (!basis) warnings.push('basis not given: set to "unknown", which does NOT count toward the chart. Use basis=visit if you went to the store yourself, basis=directory if you are writing from KlickyMart data, basis=secondhand if relaying someone else\'s experience.');
  const flags: Record<string, boolean | null> = {};
  // true/false/unknown; yes/no are accepted as aliases (case-insensitive). 1/0 stay a 400.
  const strictTri = (v0: string | undefined): "yes" | "no" | null | "bad" => { const v = v0?.toLowerCase(); return v === undefined || v === "unknown" ? null : v === "true" || v === "yes" ? "yes" : v === "false" || v === "no" ? "no" : "bad"; };
  for (const k of ["guest", "account_required", "delivered"]) { const v = strictTri(s(k)); if (v === "bad") return fail(`bad_${k}`, `${k} must be true, false or unknown (yes/no accepted) (got "${s(k)}")`); flags[k] = v === null ? null : v === "yes"; }
  const sbp: Record<string, boolean | null | "not-observed"> = { tax: null, shipping: null };
  const sbpAll = list("shown_before_payment").map((x) => x.toLowerCase());
  for (const x of sbpAll) { if (x === "none") { sbp.tax = false; sbp.shipping = false; } else if (x === "not-observed") { sbp.tax = "not-observed"; sbp.shipping = "not-observed"; } else if (x === "tax" || x === "shipping") sbp[x] = true; else if (x !== "unknown") warnings.push(`shown_before_payment "${x}" ignored (use tax, shipping, none, not-observed or unknown)`); }
  for (const k of ["tax", "shipping"]) { const raw = s(`${k}_shown_before_payment`); if (raw === "not-observed") { sbp[k] = "not-observed"; continue; } const v = strictTri(raw); if (v === "bad") return fail(`bad_${k}_shown_before_payment`, `${k}_shown_before_payment must be true, false, unknown or not-observed (got "${raw}")`); if (raw !== undefined && v !== null) sbp[k] = v === "yes"; }
  const r = s("rating"); let rating: number | null = null;
  if (r !== undefined) { rating = Number(r); if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail("bad_rating", `rating must be an integer 1-5 (got "${r}")`); }
  const rg = coarseRegion(s("region")); if (!rg.ok) return rg;
  const canonP = (c: string) => { const k = canonPay(c); if (!isPayCode(k)) warnings.push(`pay code "${c}" not in /vocab.json pay_codes; kept as given`); else if (k !== c.toLowerCase()) warnings.push(`pay code "${c}" written as "${k}" (vocab code)`); return k; };
  const tags: string[][] = [];
  if (aTag) tags.push(["a", aTag]);
  tags.push(["r", d], ["t", NOTE_HASHTAG], ["L", "klickymart.experience"], ["l", "shopping-experience", "klickymart.experience"]);
  const push = (...t: (string | undefined)[]) => { if (t.slice(1).every((x) => x !== undefined)) tags.push(t as string[]); };
  tags.push(["basis", basis ?? "unknown"]);
  // where the shipping figure and the price came from
  for (const [k, allowed] of [["shipping_source", ["policy", "checkout", "unknown"]], ["price_source", ["klickymart", "store"]]] as const) {
    const v = s(k)?.toLowerCase(); if (v === undefined) continue;
    if (!(allowed as readonly string[]).includes(v)) return fail(`bad_${k}`, `${k} must be one of ${allowed.join("|")} (got "${v}")`);
    tags.push([k, v]);
  }
  const lud = s("lud16"); if (lud) { if (/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(lud)) tags.push(["lud16", lud.toLowerCase()]); else warnings.push("lud16 ignored: expected name@domain lightning address"); }
  push("product", s("product") ?? s("product_url")); push("gtin", s("gtin")); push("depth", depth);
  if (depth) {
    tags.push(["attempt", REVIEW_ATTEMPT_OF[depth]!]);
    // Customer audit 2026-10-31 (Volt): say so when the legacy attempt tag is coarser than depth, or disagrees with a passed attempt.
    if (REVIEW_ATTEMPT_OF[depth] !== depth) warnings.push(`attempt (legacy 4-step tag) filled as "${REVIEW_ATTEMPT_OF[depth]}" for depth "${depth}"; depth is the field KlickyMart reads`);
    const given = s("depth") ? s("attempt") : undefined;
    if (given && canonDepth(given).depth && REVIEW_ATTEMPT_OF[canonDepth(given).depth!] !== REVIEW_ATTEMPT_OF[depth]) warnings.push(`attempt "${given}" disagrees with depth "${depth}"; depth wins`);
  }
  const steps = list("steps");
  for (const [i, st] of steps.entries()) tags.push(["step", String(i + 1), st.slice(0, 80)]);
  push("steps", s("steps_n") ?? (steps.length ? String(steps.length) : undefined));
  push("blocker", s("blocker")); for (const w of list("walls")) push("wall", w);
  const tf = (b: boolean | null) => (b === null ? undefined : b ? "true" : "false");
  push("guest", tf(flags.guest!)); push("account_required", tf(flags.account_required!));
  const pu = s("pay_used") ? canonP(s("pay_used")!) : undefined; push("pay_used", pu);
  // pay_offered given but empty = "none observed" (you looked and saw no methods); absent = not reported.
  const poGiven = a.pay_offered !== undefined && a.pay_offered !== null;
  const po = list("pay_offered").filter((x) => x !== "none-observed").map(canonP);
  if (po.length) tags.push(["pay_offered", ...po]); else if (poGiven) tags.push(["pay_offered", "none-observed"]);
  push("btc_route", s("btc_route"));
  const sbpOut = (v: boolean | null | "not-observed") => (v === null ? "unknown" : v === "not-observed" ? "not-observed" : v ? "true" : "false");
  for (const k of ["tax", "shipping"]) tags.push(["shown_before_payment", k, sbpOut(sbp[k]!)]);
  const cur = s("currency") ?? "USD";
  // estimated: a boolean (true = every amount given is an estimate) or a list of amount kinds.
  const estRaw = a.estimated;
  const estAll = estRaw === true || (typeof estRaw === "string" && /^(true|yes|1)$/i.test(estRaw.trim()));
  const estNone = estRaw === false || (typeof estRaw === "string" && /^(false|no|0)$/i.test(estRaw.trim()));
  const est = new Set(estAll ? [...AMOUNT_KINDS] : estNone ? [] : list("estimated").map((x) => x.toLowerCase()));
  for (const x of est) if (!(AMOUNT_KINDS as readonly string[]).includes(x)) warnings.push(`estimated "${x}" ignored (use ${AMOUNT_KINDS.join(", ")})`);
  const amounts: Record<string, { value: string; estimated: boolean }> = {};
  for (const k of ["price", "price_seen", "price_paid", "fee", "shipping", "tax", "total"]) {
    const v = s(k); if (v === undefined) continue;
    // "unknown" / "not-observed": you looked but the amount was not shown (not zero). Kept as a tag, never as a number.
    if (/^(unknown|not-observed)$/i.test(v)) { tags.push(["amount", k, v.toLowerCase(), cur]); amounts[k] = { value: v.toLowerCase(), estimated: false }; continue; }
    if (!Number.isFinite(Number(v)) || Number(v) < 0) return fail(`bad_${k}`, `${k} must be a non-negative number (got "${v}")`);
    tags.push(["amount", k, v, cur, ...(est.has(k) ? ["estimated"] : [])]); amounts[k] = { value: v, estimated: est.has(k) };
  }
  if (s("price") && !s("price_paid") && (depth === "paid" || depth === "delivered")) warnings.push("price given without price_paid: price is read as the price you saw; add price_paid if you paid a different amount");
  push("region", rg.value ?? undefined); push("duration_s", s("duration_s")); push("agent", s("agent"));
  if (flags.delivered !== null) tags.push(["delivered", tf(flags.delivered!)!, ...(s("delivery_days") ? [s("delivery_days")!] : [])]);
  if (rating !== null) tags.push(["rating", String(rating), "5"]);
  const fields = { domain: d, basis: basis ?? "unknown", counts_toward_chart: (basis ?? "unknown") === "visit", depth: depth ?? null, guest: flags.guest, account_required: flags.account_required, pay_used: pu ?? null,
    pay_offered: po.length ? po : poGiven ? "none-observed" : null,
    shown_before_payment: { tax: sbpOut(sbp.tax!), shipping: sbpOut(sbp.shipping!) }, amounts, rating, region: rg.value, delivered: flags.delivered, product: s("product") ?? s("product_url") ?? null };
  for (const p of PROOF_TAGS) push(p, s(p));
  if (rating === null) warnings.push("no rating given; add rating=1..5 so the note also counts as a review");
  return { ok: true, value: {
    unsigned_event: { kind: NOSTR_KIND_ACCEPTANCE, created_at: nowS, tags, content: s("narrative") ?? "" },
    fields, warnings,
    instructions: [
      "Sign this event yourself (NIP-01) with a site-specific key used only for shopping notes; never send KlickyMart a secret key.",
      "Consider delaying publication by a few hours to days so the note can't be matched to the order time.",
      "Keep location coarse: ZIP3, state or country only. Never include a full address, full ZIP, name, email, or order number (use order_hash = sha256 of the confirmation if you want a proof).",
      "Publish it to your relays (e.g. wss://relay.damus.io, wss://nos.lol). KlickyMart reads public relays; you can also POST the signed event to /reviews.",
    ],
    spec: "NIP-DRAFT.md#422-as-a-shopping-experience",
  } };
}

/** Keys tied to the store owner's declaration: active claimants and zap_pubkey keys from their own 31420 (pay-binding). */
async function ownerKeys(db: D1Database, d: string): Promise<Set<string>> {
  const out = new Set(await claimedKeys(db, d));
  try { for (const k of (await storeBindings(db, d)).zapKeys) out.add(k); } catch { /* */ }
  return out;
}
