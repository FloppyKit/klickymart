/** Structured shopping-experience notes on kind 422 (spec: NIP-DRAFT.md "422 as a shopping experience"), plus
 * unstructured kind-1 notes tagged #klickymart. Parsing, storage, per-store aggregates and unsigned templates.
 * KlickyMart never signs or publishes on anyone's behalf; it caches public notes and shows them next to crawl data. */
import { NOSTR_KIND_ACCEPTANCE, NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";
import { verifyNostrEvent } from "./nostr-verify";
import { utcDay } from "./agent-visits";
import { canonPay } from "./vocab";

export const EXP_DEPTHS = ["browse", "cart", "checkout", "payment", "paid", "delivered"] as const;
export const EXP_WALLS = ["captcha", "login", "bot-wall", "geo", "age-gate", "phone-verify", "none"] as const;
export const EXP_BTC_ROUTES = ["native", "indirect"] as const;
export const PROOF_TAGS = ["zap", "preimage", "cashu", "order_hash"] as const;
export const KIND_NOTE = 1;
export const NOTE_HASHTAG = "klickymart";
const LEGACY_ATTEMPT: Record<string, string> = { browse: "browse", cart: "cart", checkout: "checkout", paid: "paid" };
/** Experience tag names, documented in llms.txt / NIP-DRAFT. All optional except the store reference. */
export const EXP_TAGS = ["a", "r", "product", "gtin", "depth", "step", "steps", "blocker", "wall", "guest", "account_required", "pay_used", "pay_offered", "btc_route",
  "shown_before_payment", "amount", "region", "duration_s", "agent", "delivered", "rating", ...PROOF_TAGS] as const;

export interface Experience {
  id: string; kind: number; d: string; pubkey: string; created_at: number; structured: boolean;
  depth: string | null; guest: string | null; account_required: string | null; pay_used: string | null; pay_offered: string[]; btc_route: string | null;
  tax_before: string | null; ship_before: string | null; price: number | null; shipping: number | null; tax: number | null; total: number | null; currency: string | null;
  region: string | null; steps_n: number | null; duration_s: number | null; blocker: string | null; walls: string[]; agent: string | null;
  delivered: string | null; delivery_days: number | null; rating5: number | null; product: string | null; proof: string | null; content: string;
}
type Res<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });
const tv = (tags: string[][], n: string) => tags.find((t) => t[0] === n);
const yn = (v: string | undefined) => (v === "yes" || v === "true" ? "yes" : v === "no" || v === "false" ? "no" : null);
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
  const depth = tv(tags, "depth")?.[1] ?? LEGACY_ATTEMPT[tv(tags, "attempt")?.[1] ?? ""] ?? null;
  if (depth && !(EXP_DEPTHS as readonly string[]).includes(depth)) return fail("bad_depth", `depth must be one of ${EXP_DEPTHS.join("|")}`);
  const rg = coarseRegion(tv(tags, "region")?.[1]); if (!rg.ok) return rg;
  if (/\b\d{5}(-\d{4})?\b/.test(tags.filter((t) => t[0] === "region").flat().join(" "))) return fail("region_too_precise", "never put a full ZIP in tags");
  const r = tv(tags, "rating"); let rating5: number | null = null;
  if (r) { const n = Number(r[1]), m = Number(r[2] ?? "5"); if (!Number.isFinite(n) || !Number.isFinite(m) || m < 1 || m > 10 || n < 0 || n > m) return fail("bad_rating", 'need ["rating","<0..max>","<max>"]'); rating5 = Math.round((n * 5 / m) * 10) / 10; }
  if (structured && !depth && rating5 === null) return fail("not_an_experience", 'a 422 experience needs at least ["depth",...] or ["rating",...]');
  const amt = (k: string) => { const t = tags.find((x) => x[0] === "amount" && x[1] === k); return t ? { v: num(t[2]), c: t[3] ?? null } : null; };
  const price = amt("price"), ship = amt("shipping"), tax = amt("tax"), total = amt("total");
  const sbp = (k: string) => yn(tags.find((x) => x[0] === "shown_before_payment" && x[1] === k)?.[2]);
  const payUsed = tv(tags, "pay_used")?.[1] ?? tv(tags, "pay")?.[1] ?? null;
  const pay_offered = [...new Set(tags.filter((t) => t[0] === "pay_offered").flatMap((t) => t.slice(1)).map((x) => canonPay(x.toLowerCase())).filter((x): x is string => !!x))];
  const br = tv(tags, "btc_route")?.[1] ?? null;
  if (br && !(EXP_BTC_ROUTES as readonly string[]).includes(br)) return fail("bad_btc_route", "btc_route must be native or indirect");
  const steps = tags.filter((t) => t[0] === "step");
  const del = tv(tags, "delivered");
  const proof = (PROOF_TAGS as readonly string[]).find((p) => tv(tags, p)) ?? null;
  if (tv(tags, "order_hash") && !/^[0-9a-f]{64}$/i.test(tv(tags, "order_hash")![1] ?? "")) return fail("bad_order_hash", "order_hash must be a 64-hex sha256 of the order confirmation (never the confirmation itself)");
  return { ok: true, value: {
    id: ev.id.toLowerCase(), kind: ev.kind, d, pubkey: ev.pubkey.toLowerCase(), created_at: ev.created_at, structured,
    depth, guest: yn(tv(tags, "guest")?.[1]), account_required: yn(tv(tags, "account_required")?.[1]),
    pay_used: payUsed ? canonPay(payUsed.toLowerCase()) ?? payUsed.toLowerCase().slice(0, 40) : null, pay_offered, btc_route: br,
    tax_before: sbp("tax"), ship_before: sbp("shipping"), price: price?.v ?? null, shipping: ship?.v ?? null, tax: tax?.v ?? null, total: total?.v ?? null,
    currency: (total?.c ?? price?.c ?? ship?.c ?? tax?.c ?? null)?.toUpperCase().slice(0, 3) ?? null, region: rg.value,
    steps_n: num(tv(tags, "steps")?.[1]) ?? (steps.length || null), duration_s: num(tv(tags, "duration_s")?.[1]),
    blocker: tv(tags, "blocker")?.[1]?.slice(0, 40) ?? null, walls: tags.filter((t) => t[0] === "wall").map((t) => t[1]!).filter((w) => (EXP_WALLS as readonly string[]).includes(w)),
    agent: tv(tags, "agent")?.[1]?.slice(0, 60) ?? null, delivered: del ? yn(del[1]) : null, delivery_days: del ? num(del[2]) : null,
    rating5, product: (tv(tags, "product")?.[1] ?? (tv(tags, "gtin") ? `gtin:${tv(tags, "gtin")![1]}` : null))?.slice(0, 300) ?? null, proof, content: ev.content,
  } };
}

export async function storeExperience(db: D1Database, x: Experience, raw: unknown, src: { source: "post" | "relay"; relays?: string | null; proof_status?: string | null }, now = Date.now()) {
  const r = await db.prepare(`INSERT OR IGNORE INTO experiences (id,kind,d,pubkey,created_at,structured,depth,guest,account_required,pay_used,pay_offered,btc_route,tax_before,ship_before,price,shipping,tax,total,currency,region,steps_n,duration_s,blocker,walls,agent,delivered,delivery_days,rating5,product,proof,proof_status,content,raw_json,source,relays,received_day)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    x.id, x.kind, x.d, x.pubkey, x.created_at, x.structured ? 1 : 0, x.depth, x.guest, x.account_required, x.pay_used, JSON.stringify(x.pay_offered), x.btc_route, x.tax_before, x.ship_before,
    x.price, x.shipping, x.tax, x.total, x.currency, x.region, x.steps_n, x.duration_s, x.blocker, JSON.stringify(x.walls), x.agent, x.delivered, x.delivery_days, x.rating5, x.product, x.proof,
    src.proof_status ?? (x.proof ? "proof-attached" : null), x.content, JSON.stringify(raw), src.source, src.relays ?? null, utcDay(now)).run();
  return (r.meta?.changes ?? 0) > 0 ? "stored" : "duplicate";
}

export const MIN_KEYS = 2;
const DEPTH_RANK: Record<string, number> = { browse: 0, cart: 1, checkout: 2, payment: 3, paid: 4, delivered: 5 };
/** Weight of one key's evidence: 1 by default, 2 with a proof attached, 3 when the proof was checked. */
export const proofWeight = (proof: string | null, status: string | null) => (status?.startsWith("verified") ? 3 : proof ? 2 : 1);
type Row = Experience & { proof_status: string | null; walls_json?: string };

export interface StoreAggregate {
  d: string; source: "community"; notes: number; structured_notes: number; unstructured_notes: number; keys: number; corroborated: boolean;
  depth: Record<string, number>; reached_checkout_keys: number; paid_keys: number; success_score: number | null;
  blockers: { kind: string; keys: number }[]; walls: { kind: string; keys: number }[];
  pay_used: { pay: string; keys: number; corroborated: boolean }[];
  guest_yes_keys: number; guest_no_keys: number; account_required_keys: number;
  tax_before: { yes: number; no: number }; ship_before: { yes: number; no: number };
  observed: { shipping_usd: { median: number | null; n: number; keys: number; corroborated: boolean }; tax_rate_pct: { median: number | null; n: number; keys: number; corroborated: boolean } };
  verified_purchase_share: number; proof_keys: number; avg_rating_5: number | null; latest_at: number | null; notes_30d: number; rules: string;
}
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 100) / 100; };

/** Aggregate one store's notes. Counts are distinct pubkeys (each key's latest structured note; any proof from a key counts once). */
export function aggregate(d: string, rows: Row[], now = Date.now()): StoreAggregate {
  const nowS = Math.floor(now / 1000);
  const sorted = [...rows].sort((a, b) => b.created_at - a.created_at);
  const latest = new Map<string, Row>();
  for (const r of sorted) if (r.structured && !latest.has(r.pubkey)) latest.set(r.pubkey, r);
  const per = [...latest.values()];
  const keysAll = new Set(rows.map((r) => r.pubkey));
  const proofKeys = new Set(rows.filter((r) => r.proof).map((r) => r.pubkey));
  const wOf = new Map<string, number>(); for (const r of rows) wOf.set(r.pubkey, Math.max(wOf.get(r.pubkey) ?? 1, proofWeight(r.proof, r.proof_status)));
  const depth: Record<string, number> = Object.fromEntries(EXP_DEPTHS.map((x) => [x, 0]));
  for (const r of per) if (r.depth) depth[r.depth] = (depth[r.depth] ?? 0) + 1;
  const count = (f: (r: Row) => string | string[] | null) => { const m = new Map<string, Set<string>>(); for (const r of per) { const v = f(r); for (const k of Array.isArray(v) ? v : v ? [v] : []) { const s = m.get(k) ?? new Set(); s.add(r.pubkey); m.set(k, s); } } return [...m.entries()].map(([kind, s]) => ({ kind, keys: s.size })).sort((a, b) => b.keys - a.keys); };
  const reached = per.filter((r) => r.depth && DEPTH_RANK[r.depth]! >= 2);
  const paid = per.filter((r) => r.depth && DEPTH_RANK[r.depth]! >= 4);
  // weighted share of keys that reached payment or beyond; null until 2 keys
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
    avg_rating_5: rated.length ? Math.round((rated.reduce((a, r) => a + r.rating5!, 0) / rated.length) * 10) / 10 : null,
    latest_at: sorted[0]?.created_at ?? null, notes_30d: rows.filter((r) => r.created_at >= nowS - 30 * 86400).length,
    rules: `Distinct keys; each key's latest structured note counts once. ${MIN_KEYS}+ keys before a value is 'corroborated'. Proof tags (zap, preimage, cashu, order_hash) weigh 2, checked proofs 3. Unstructured kind-1 notes count toward 'notes' only. Crawl data is never overwritten.`,
  };
}

const COLS = "id,kind,d,pubkey,created_at,structured,depth,guest,account_required,pay_used,pay_offered,btc_route,tax_before,ship_before,price,shipping,tax,total,currency,region,steps_n,duration_s,blocker,walls,agent,delivered,delivery_days,rating5,product,proof,proof_status,content";
const fromDb = (r: Record<string, any>): Row => ({ ...r, structured: r.structured === 1, pay_offered: JSON.parse(r.pay_offered || "[]"), walls: JSON.parse(r.walls || "[]") }) as Row;
export async function loadAggregates(db: D1Database | undefined, domains?: string[], now = Date.now()): Promise<Map<string, StoreAggregate>> {
  const out = new Map<string, StoreAggregate>();
  if (!db) return out;
  try {
    const q = domains?.length ? `SELECT ${COLS} FROM experiences WHERE d IN (${domains.map(() => "?").join(",")})` : `SELECT ${COLS} FROM experiences`;
    const { results } = await db.prepare(q).bind(...(domains ?? [])).all<Record<string, any>>();
    const by = new Map<string, Row[]>();
    for (const r of results ?? []) { const x = fromDb(r); const l = by.get(x.d) ?? []; l.push(x); by.set(x.d, l); }
    for (const [d, rows] of by) out.set(d, aggregate(d, rows, now));
  } catch { /* migration pending */ }
  return out;
}

/** Unsigned event template for the agent to sign and publish itself. */
export function experienceTemplate(a: Record<string, unknown>, aTag: string | null, nowS = Math.floor(Date.now() / 1000)): Res<Record<string, unknown>> {
  const s = (k: string) => (a[k] === undefined || a[k] === null || a[k] === "" ? undefined : String(a[k]));
  const d = s("domain")?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!d) return fail("missing_domain", "domain is required");
  const depth = s("depth"); if (depth && !(EXP_DEPTHS as readonly string[]).includes(depth)) return fail("bad_depth", `depth must be one of ${EXP_DEPTHS.join("|")}`);
  const rg = coarseRegion(s("region")); if (!rg.ok) return rg;
  const tags: string[][] = [];
  if (aTag) tags.push(["a", aTag]);
  tags.push(["r", d], ["t", NOTE_HASHTAG], ["L", "klickymart.experience"], ["l", "shopping-experience", "klickymart.experience"]);
  const push = (...t: (string | undefined)[]) => { if (t.slice(1).every((x) => x !== undefined)) tags.push(t as string[]); };
  push("product", s("product_url")); push("gtin", s("gtin")); push("depth", depth);
  for (const [i, st] of ((a.steps as unknown[]) ?? []).entries()) tags.push(["step", String(i + 1), String(st).slice(0, 80)]);
  push("steps", s("steps_n") ?? (Array.isArray(a.steps) && a.steps.length ? String(a.steps.length) : undefined));
  push("blocker", s("blocker")); for (const w of ((a.walls as string[]) ?? [])) push("wall", w);
  push("guest", s("guest")); push("account_required", s("account_required"));
  push("pay_used", s("pay_used")); const po = (a.pay_offered as string[]) ?? []; if (po.length) tags.push(["pay_offered", ...po.map(String)]);
  push("btc_route", s("btc_route"));
  push("shown_before_payment", "tax", s("tax_shown_before_payment")); push("shown_before_payment", "shipping", s("shipping_shown_before_payment"));
  const cur = s("currency") ?? "USD";
  for (const k of ["price", "shipping", "tax", "total"]) push("amount", k, s(k), cur);
  push("region", rg.value ?? undefined); push("duration_s", s("duration_s")); push("agent", s("agent"));
  if (s("delivered")) tags.push(["delivered", s("delivered")!, ...(s("delivery_days") ? [s("delivery_days")!] : [])]);
  if (s("rating")) tags.push(["rating", s("rating")!, s("rating_max") ?? "5"]);
  for (const p of PROOF_TAGS) push(p, s(p));
  return { ok: true, value: {
    unsigned_event: { kind: NOSTR_KIND_ACCEPTANCE, created_at: nowS, tags, content: s("narrative") ?? "" },
    instructions: [
      "Sign this event yourself (NIP-01) with a site-specific key used only for shopping notes; never send KlickyMart a secret key.",
      "Consider delaying publication by a few hours to days so the note can't be matched to the order time.",
      "Keep location coarse: ZIP3, state or country only. Never include a full address, full ZIP, name, email, or order number (use order_hash = sha256 of the confirmation if you want a proof).",
      "Publish it to your relays (e.g. wss://relay.damus.io, wss://nos.lol). KlickyMart reads public relays; you can also POST the signed event to /reviews.",
    ],
    spec: "NIP-DRAFT.md#422-as-a-shopping-experience",
  } };
}
