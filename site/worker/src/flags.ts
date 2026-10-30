import { takeAll, utcDayOf } from "./ratelimit";
/** Explainable anti-gaming scorer for agent notes (422 / kind-1 shopping experiences).
 * It FLAGS, never hides or deletes: flagged notes stay public with their reasons, and only their chart weight drops
 * (weak flag x0.5, strong flag or 2+ independent signals x0). Inputs are public Nostr data only; never IP addresses.
 * Authors can appeal by replying to the note or deleting it (NIP-09). */
import { decodeBolt11 } from "./bolt11";
import { loadTips, tipWeight, bonusEligible, type Tip } from "./tips";
import { BIG_NIP05_PROVIDERS, verifiedNip05 } from "./nip05";

export const REPORT_KIND = 1984;
export const FLAG_LIMITS = { reportsPerKeyPerDay: 10, minReporters: 2, strongReporters: 4 };
const H = 3600, DAY = 86400;
export type Signal = "new-key-burst" | "timing-cluster" | "near-duplicate" | "tip-ring" | "tip-only-tippers" | "implausible-data" | "same-operator" | "community-reports";
export interface FlagReason { signal: Signal; strength: "weak" | "strong"; detail: string }
export interface NoteFlag { id: string; d: string; pubkey: string; reasons: FlagReason[]; level: "weak" | "strong"; weight: number; tip_weight?: number }
export const FLAG_RULES = "Flags are explainable: each lists the public signals behind it. A flagged note stays visible; one weak signal halves its chart weight, a strong signal or two independent signals set it to zero. Signals: bursts of brand-new keys on one store, suspiciously regular timing, near-duplicate notes from different keys, circular or tip-only tipping, data that is implausible against other notes or the crawl, public same-operator hints (e.g. a shared lightning address), and corroborated community reports (NIP-56 kind 1984). Appeal: reply to your note with context, or delete it (NIP-09). We never use IP addresses.";

export interface FNote { id: string; d: string; pubkey: string; created_at: number; content: string; depth: string | null; price: number | null; currency: string | null; duration_s: number | null; steps_n: number | null; blocker: string | null; shipping: number | null; tax: number | null; tags: string[][] }
export interface Report { id: string; pubkey: string; created_at: number; target: string; reason: string }
export interface FlagCtx {
  firstSeen: Map<string, number>;          // pubkey -> earliest created_at of any event we hold from it
  active: Set<string>;                     // pubkeys with any non-report, non-zap-request activity (notes, 42x, 31420, receipts signed)
  tips: Map<string, Tip[]>;                // note id -> tips
  reports: Report[];
  fulfillmentMsat: Map<string, number>;    // 421 id -> invoice amount
  inStoreOnly?: Set<string>;               // crawl: domains with in-store payment only (no online checkout)
  crawlPrices?: Map<string, { min: number; max: number; n: number }>; // our crawl/offer prices (USD) per store
  nip05?: Map<string, string>;             // pubkey -> NIP-05 domain we verified
}
export interface FlagStatic { inStoreOnly: Set<string>; crawlPrices: Map<string, { min: number; max: number; n: number }> }

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9$.\s]/g, " ").split(/\s+/).filter(Boolean);
const shingles = (s: string) => { const w = words(s); const o = new Set<string>(); for (let i = 0; i + 2 < w.length; i++) o.add(w.slice(i, i + 3).join(" ")); return o; };
export function jaccard(a: Set<string>, b: Set<string>) { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); }
const tag = (t: string[][], n: string) => t.find((x) => x[0] === n)?.[1];
const DEEP = new Set(["payment", "paid", "delivered"]);

export function computeFlags(notes: FNote[], ctx: FlagCtx): Map<string, NoteFlag> {
  const R = new Map<string, FlagReason[]>();
  const add = (id: string, r: FlagReason) => { const l = R.get(id) ?? []; if (!l.some((x) => x.signal === r.signal)) l.push(r); R.set(id, l); };
  const byStore = new Map<string, FNote[]>();
  for (const n of notes) (byStore.get(n.d) ?? byStore.set(n.d, []).get(n.d)!).push(n);
  const byId = new Map(notes.map((n) => [n.id, n]));

  for (const [d, list] of byStore) {
    const s = [...list].sort((a, b) => a.created_at - b.created_at);
    // 1. burst of brand-new keys on one store
    const isNew = (n: FNote) => (ctx.firstSeen.get(n.pubkey) ?? n.created_at) >= n.created_at - 2 * DAY;
    for (const n of s) {
      if (!isNew(n)) continue;
      const keys = new Set(s.filter((m) => isNew(m) && Math.abs(m.created_at - n.created_at) <= 12 * H).map((m) => m.pubkey));
      if (keys.size >= 3) add(n.id, { signal: "new-key-burst", strength: keys.size >= 6 ? "strong" : "weak", detail: `${keys.size} brand-new keys posted about ${d} within a day` });
    }
    // 2a. evenly spaced timestamps across different keys (run of 4+ notes)
    for (let i = 0; i + 3 < s.length; i++) {
      const run = s.slice(i, i + 4); const gaps = run.slice(1).map((m, k) => m.created_at - run[k]!.created_at);
      if (new Set(run.map((m) => m.pubkey)).size === 4 && gaps.every((g) => g > 0 && g <= 6 * H && Math.abs(g - gaps[0]!) <= 2))
        for (const m of run) add(m.id, { signal: "timing-cluster", strength: "weak", detail: `posted at near-identical intervals (~${gaps[0]}s) with other keys` });
    }
    // 2b. near-duplicate text or identical detailed field values across different keys
    const sh = s.map((n) => ({ n, sh: words(n.content).length >= 8 ? shingles(n.content) : new Set<string>() }));
    for (const a of sh) {
      const dup = sh.filter((b) => b.n.pubkey !== a.n.pubkey && jaccard(a.sh, b.sh) >= 0.7);
      if (dup.length) add(a.n.id, { signal: "near-duplicate", strength: dup.length >= 2 ? "strong" : "weak", detail: `text nearly identical to notes from ${new Set(dup.map((x) => x.n.pubkey)).size} other key(s)` });
    }
    const fp = (n: FNote) => (n.duration_s != null && n.steps_n != null ? JSON.stringify([n.depth, n.price, n.shipping, n.tax, n.duration_s, n.steps_n, n.blocker]) : null);
    const fps = new Map<string, Set<string>>();
    for (const n of s) { const f = fp(n); if (f) (fps.get(f) ?? fps.set(f, new Set()).get(f)!).add(n.pubkey); }
    for (const n of s) { const k = fps.get(fp(n) ?? ""); if (k && k.size >= 3) add(n.id, { signal: "near-duplicate", strength: "weak", detail: `identical timing and field values as ${k.size - 1} other keys` }); }
    // 4. implausible data
    for (const n of s) {
      const others = s.filter((m) => m.pubkey !== n.pubkey && m.price != null && m.price > 0 && (m.currency ?? "USD") === (n.currency ?? "USD")).map((m) => m.price!).sort((a, b) => a - b);
      if (n.price != null && n.price > 0 && others.length >= 2) {
        const med = others[(others.length - 1) >> 1]!;
        if (n.price > med * 5 || n.price < med / 5) add(n.id, { signal: "implausible-data", strength: "weak", detail: `price ${n.price} is far from other agents' median ${med}` });
      }
      const cp = ctx.crawlPrices?.get(d);
      if (cp && n.price != null && n.price > 0 && (n.currency ?? "USD") === "USD" && (n.price > cp.max * 5 || n.price < cp.min / 5))
        add(n.id, { signal: "implausible-data", strength: "weak", detail: `price ${n.price} is far outside the prices our crawl saw at this store (${cp.min}-${cp.max} USD)` });
      if (ctx.inStoreOnly?.has(d) && n.depth && DEEP.has(n.depth)) add(n.id, { signal: "implausible-data", strength: "weak", detail: "claims an online payment step; our crawl found in-store payment only" });
      const ful = n.tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1];
      const toMsat = (t: string[]) => { const v = Number(t[2]); const c = (t[3] ?? "").toLowerCase(); return !(v > 0) ? NaN : c === "msat" ? v : c === "sat" || c === "sats" ? v * 1000 : c === "btc" ? v * 1e11 : NaN; };
      const at = n.tags.find((t) => t[0] === "amount" && /^\d+$/.test(t[1] ?? "")) ; // legacy ["amount", <msat>]
      const pt = n.tags.find((t) => t[0] === "amount" && (t[1] === "price_paid" || t[1] === "total"));
      const stated = at ? Number(at[1]) : pt ? toMsat(pt) : NaN;
      const inv = ful ? ctx.fulfillmentMsat.get(ful) : undefined;
      if (inv && stated > 0 && Math.abs(inv - stated) > 0.1 * Math.max(inv, stated)) add(n.id, { signal: "implausible-data", strength: "strong", detail: `stated amount ${stated} msat does not match the cited invoice (${inv} msat)` });
    }
  }
  // 5. public same-operator hints: one lightning address on several keys
  const lud = new Map<string, Set<string>>();
  for (const n of notes) { const l = tag(n.tags, "lud16")?.toLowerCase(); if (l) (lud.get(l) ?? lud.set(l, new Set()).get(l)!).add(n.pubkey); }
  for (const n of notes) { const k = lud.get(tag(n.tags, "lud16")?.toLowerCase() ?? ""); if (k && k.size >= 2) add(n.id, { signal: "same-operator", strength: k.size >= 3 ? "strong" : "weak", detail: `lightning address shared by ${k.size} keys` }); }
  // 5b. NIP-05: several keys verified under one domain posting about the same store (big public providers: weak at most)
  if (ctx.nip05?.size) for (const [, list] of byStore) {
    const byDom = new Map<string, Set<string>>();
    for (const n of list) { const dm = ctx.nip05.get(n.pubkey); if (dm) (byDom.get(dm) ?? byDom.set(dm, new Set()).get(dm)!).add(n.pubkey); }
    for (const n of list) {
      const dm = ctx.nip05.get(n.pubkey); const k = dm ? byDom.get(dm)! : null; if (!k) continue;
      const big = BIG_NIP05_PROVIDERS.has(dm!);
      if (big ? k.size >= 4 : k.size >= 2) add(n.id, { signal: "same-operator", strength: !big && k.size >= 3 ? "strong" : "weak", detail: `${k.size} keys verified under one NIP-05 domain${big ? " (a large public provider)" : ""} posted about this store` });
    }
  }
  // 3. tip rings and tip-only tippers
  const author = (id: string) => byId.get(id)?.pubkey;
  const edges = new Set<string>();
  for (const [id, tips] of ctx.tips) for (const t of tips) if (!t.self && t.tipper && author(id)) edges.add(`${t.tipper}>${author(id)}`);
  const ring = new Set<string>();
  const outs = new Map<string, Set<string>>();
  for (const e of edges) { const [a, b] = e.split(">") as [string, string]; (outs.get(a) ?? outs.set(a, new Set()).get(a)!).add(b); }
  for (const [a, bs] of outs) for (const b of bs) {
    if (outs.get(b)?.has(a)) { ring.add(a); ring.add(b); }
    for (const c of outs.get(b) ?? []) if (c !== a && outs.get(c)?.has(a)) { ring.add(a); ring.add(b); ring.add(c); }
  }
  const tipW = new Map<string, number>();
  for (const [id, tips] of ctx.tips) {
    const n = byId.get(id); if (!n) continue;
    const val = [...new Set(tips.filter((t) => !t.self && t.validated && t.tipper).map((t) => t.tipper!))];
    const bonus = [...new Set(tips.filter(bonusEligible).map((t) => t.tipper!))];
    const bad = val.filter((p) => (ring.has(p) && ring.has(n.pubkey)) || !ctx.active.has(p));
    if (ring.has(n.pubkey) && val.some((p) => ring.has(p))) add(id, { signal: "tip-ring", strength: "weak", detail: "author and tippers tip each other in a small circle" });
    if (val.length && val.filter((p) => !ctx.active.has(p)).length * 2 >= val.length) add(id, { signal: "tip-only-tippers", strength: "weak", detail: "most tips come from keys whose only activity is tipping" });
    if (bad.length) tipW.set(id, tipWeight(bonus.filter((p) => !bad.includes(p)).length));
  }
  // 6. community reports (NIP-56), distinct reporters, reporters checked too
  const reps = new Map<string, Report[]>();
  for (const r of ctx.reports) if (byId.has(r.target) && r.pubkey !== author(r.target)) (reps.get(r.target) ?? reps.set(r.target, []).get(r.target)!).push(r);
  for (const [id, rs] of reps) {
    const ok = new Map<string, Report>();
    for (const r of rs) {
      const seen = ctx.firstSeen.get(r.pubkey) ?? r.created_at;
      const burst = rs.filter((x) => (ctx.firstSeen.get(x.pubkey) ?? x.created_at) >= x.created_at - 2 * DAY && Math.abs(x.created_at - r.created_at) <= H).length >= 3;
      const qualifies = (ctx.active.has(r.pubkey) || seen <= r.created_at - 7 * DAY) && !burst;
      if (qualifies && !ok.has(r.pubkey)) ok.set(r.pubkey, r);
    }
    if (ok.size >= FLAG_LIMITS.minReporters) {
      const why = [...new Set([...ok.values()].map((r) => r.reason || "unspecified"))].slice(0, 5).join(", ");
      add(id, { signal: "community-reports", strength: ok.size >= FLAG_LIMITS.strongReporters ? "strong" : "weak", detail: `reported by ${ok.size} independent keys (${why})` });
    }
  }
  const out = new Map<string, NoteFlag>();
  for (const [id, reasons] of R) {
    const n = byId.get(id)!;
    const strong = reasons.some((r) => r.strength === "strong") || new Set(reasons.map((r) => r.signal)).size >= 2;
    out.set(id, { id, d: n.d, pubkey: n.pubkey, reasons, level: strong ? "strong" : "weak", weight: strong ? 0 : 0.5, ...(tipW.has(id) ? { tip_weight: tipW.get(id) } : {}) });
  }
  for (const [id, w] of tipW) if (!out.has(id)) { const n = byId.get(id)!; out.set(id, { id, d: n.d, pubkey: n.pubkey, reasons: [], level: "weak", weight: 1, tip_weight: w }); }
  return out;
}

/** Summary per store for APIs. Notes whose only effect is discounted tips are not counted as flagged. */
export function flagSummary(flags: NoteFlag[]) {
  const f = flags.filter((x) => x.reasons.length);
  const by: Record<string, number> = {};
  for (const x of f) for (const r of x.reasons) by[r.signal] = (by[r.signal] ?? 0) + 1;
  return { flagged_notes: f.length, strong: f.filter((x) => x.level === "strong").length, reasons: by };
}

type Row = Record<string, any>;
export async function loadFlagContext(db: D1Database, notes: FNote[], st?: Partial<FlagStatic>): Promise<FlagCtx> {
  const ctx: FlagCtx = { firstSeen: new Map(), active: new Set(), tips: new Map(), reports: [], fulfillmentMsat: new Map(), inStoreOnly: st?.inStoreOnly, crawlPrices: st?.crawlPrices, nip05: await verifiedNip05(db) };
  try {
    for (const q of ["SELECT pubkey, MIN(created_at) AS t FROM nostr_events GROUP BY pubkey", "SELECT pubkey, MIN(created_at) AS t FROM experiences GROUP BY pubkey"]) {
      const { results } = await db.prepare(q).all<{ pubkey: string; t: number }>();
      for (const r of results ?? []) ctx.firstSeen.set(r.pubkey, Math.min(ctx.firstSeen.get(r.pubkey) ?? Infinity, r.t));
    }
    const act = await db.prepare("SELECT DISTINCT pubkey FROM nostr_events WHERE kind != ? UNION SELECT DISTINCT pubkey FROM experiences").bind(REPORT_KIND).all<{ pubkey: string }>();
    for (const r of act.results ?? []) ctx.active.add(r.pubkey);
    ctx.tips = (await loadTips(db)).byNote;
    const rep = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = ?").bind(REPORT_KIND).all<{ raw_json: string }>();
    for (const r of rep.results ?? []) { const p = parseReport(JSON.parse(r.raw_json)); if (p) ctx.reports.push(p); }
    const fids = [...new Set(notes.map((n) => n.tags.find((t) => t[0] === "e" && t[3] === "fulfillment")?.[1]).filter((x): x is string => !!x))];
    for (let k = 0; k < fids.length; k += 90) {
      const chunk = fids.slice(k, k + 90);
      const { results } = await db.prepare(`SELECT id, raw_json FROM nostr_events WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<Row>();
      for (const r of results ?? []) { const b = (JSON.parse(r.raw_json).tags as string[][]).find((t) => t[0] === "bolt11")?.[1]; const a = b ? decodeBolt11(b)?.amount_msat : null; if (a) ctx.fulfillmentMsat.set(r.id, a); }
    }
  } catch { /* migration pending */ }
  return ctx;
}

/** NIP-56 report -> {target note, reason}. Reason is the 3rd element of the e tag (spam, impersonation, other, ...) or the content. */
export function parseReport(ev: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string }): Report | null {
  if (ev?.kind !== REPORT_KIND) return null;
  const e = ev.tags.find((t) => t[0] === "e" && /^[0-9a-f]{64}$/.test(t[1] ?? ""));
  if (!e) return null;
  return { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, target: e[1]!, reason: String(e[2] || ev.content || "other").slice(0, 60) };
}

export function rowToFNote(r: Row): FNote {
  let tags: string[][] = []; try { tags = JSON.parse(r.raw_json).tags ?? []; } catch { /* */ }
  return { id: r.id, d: r.d, pubkey: r.pubkey, created_at: r.created_at, content: r.content ?? "", depth: r.depth ?? null, price: r.price ?? null, currency: r.currency ?? null, duration_s: r.duration_s ?? null, steps_n: r.steps_n ?? null, blocker: r.blocker ?? null, shipping: r.shipping ?? null, tax: r.tax ?? null, tags };
}

/** Domains our crawl found to take in-store payment only (no online payment). */
export function inStoreOnly(snap: { rows: { d: string; pay_online: number; pay_instore: number }[] }): Set<string> {
  return new Set(snap.rows.filter((r) => r.pay_online === 0 && r.pay_instore > 0).map((r) => r.d));
}

/** POST /flag: store a signed NIP-56 report about a note we hold. Not published. Rate-limited per key and overall. */
export async function submitReport(db: D1Database, ev: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const bad = (code: string, message: string, status = 400) => ({ status, body: { ok: false, error: { code, message } } });
  if (ev && typeof ev === "object" && Object.keys(ev).some((k) => /nsec|secret|priv/i.test(k))) return bad("secret_sent", "never send a secret key");
  const { verifyNostrEvent } = await import("./nostr-verify");
  if (!verifyNostrEvent(ev as never, REPORT_KIND).ok) return bad("bad_signature", "send a validly signed kind 1984 (NIP-56) event");
  const p = parseReport(ev);
  if (!p) return bad("bad_tags", 'need ["e", <note id>, <reason>]');
  const nowS = Math.floor(Date.now() / 1000);
  if (ev.created_at > nowS + 600 || ev.created_at < nowS - 7 * DAY) return bad("bad_time", "created_at must be within the last 7 days");
  const t = await db.prepare("SELECT d FROM experiences WHERE id = ? UNION SELECT d FROM reviews WHERE id = ?").bind(p.target, p.target).first<{ d: string }>();
  if (!t) return bad("unknown_note", "we hold no note with that id");
  const n = await db.prepare("SELECT (SELECT COUNT(*) FROM nostr_events WHERE kind = ? AND pubkey = ? AND first_seen > ?) AS k, (SELECT COUNT(*) FROM nostr_events WHERE kind = ? AND first_seen > ?) AS g").bind(REPORT_KIND, ev.pubkey, nowS - DAY, REPORT_KIND, nowS - DAY).first<{ k: number; g: number }>();
  if ((n?.k ?? 0) >= FLAG_LIMITS.reportsPerKeyPerDay || (n?.g ?? 0) >= 1000) return bad("rate_limited", `max ${FLAG_LIMITS.reportsPerKeyPerDay} reports per key per day`, 429);
  if (!(await db.prepare("SELECT 1 FROM nostr_events WHERE id = ?").bind(ev.id).first())) { // KM-008: atomic decision
    const day = utcDayOf(Date.now());
    if (await takeAll(db, [{ k: `fl:g:${day}`, limit: 1000, ttlS: 2 * DAY }, { k: `fl:pk:${ev.pubkey}:${day}`, limit: FLAG_LIMITS.reportsPerKeyPerDay, ttlS: 2 * DAY }]))
      return bad("rate_limited", `max ${FLAG_LIMITS.reportsPerKeyPerDay} reports per key per day`, 429);
  }
  const r = await db.prepare("INSERT OR IGNORE INTO nostr_events (id,kind,pubkey,created_at,d,raw_json,first_seen,relays) VALUES (?,?,?,?,?,?,?,?)").bind(ev.id, REPORT_KIND, ev.pubkey, ev.created_at, t.d, JSON.stringify(ev), nowS, "post").run();
  return { status: (r.meta?.changes ?? 0) > 0 ? 201 : 200, body: { ok: true, id: ev.id, target: p.target, reason: p.reason, published: false,
    note: `Counted once per reporter key; a note is flagged only when ${FLAG_LIMITS.minReporters}+ independent keys report it. Reporters are checked for gaming too. You may also publish this report to relays yourself.` } };
}

/** Crawl-side inputs (from the snapshot and our offers file). */
export async function buildFlagStatic(snap: { rows: { d: string; pay_online: number; pay_instore: number }[] }): Promise<FlagStatic> {
  const crawlPrices = new Map<string, { min: number; max: number; n: number }>();
  try {
    const { EMBEDDED_OFFERS_NDJSON } = await import("./fixture-data");
    const { parseOffers } = await import("./offers");
    for (const o of parseOffers(EMBEDDED_OFFERS_NDJSON || "")) {
      const p = o.dn?.price_usd ?? o.p; if (!(p > 0) || (o.c && o.c !== "USD")) continue;
      const c = crawlPrices.get(o.d); crawlPrices.set(o.d, c ? { min: Math.min(c.min, p), max: Math.max(c.max, p), n: c.n + 1 } : { min: p, max: p, n: 1 });
    }
  } catch { /* no offers */ }
  return { inStoreOnly: inStoreOnly(snap), crawlPrices };
}

const NOTE_COLS = "id,d,pubkey,created_at,content,depth,price,currency,duration_s,steps_n,blocker,shipping,tax,raw_json";
/** Full scan: every stored note scored with the full public context. */
export async function scanFlags(db: D1Database, st?: Partial<FlagStatic>): Promise<Map<string, NoteFlag>> {
  const { results } = await db.prepare(`SELECT ${NOTE_COLS} FROM experiences`).all<Row>();
  const notes = (results ?? []).map(rowToFNote);
  return computeFlags(notes, await loadFlagContext(db, notes, st));
}

/** Recompute after a write (ingest, POST, deletion, claim, NIP-05 pass) and write only the rows that changed.
 * Signals can cross stores (tip rings, shared addresses), so the score is computed over all notes; the cache write is the
 * incremental part. Request paths read the cache. */
export async function refreshFlagCache(db: D1Database, st?: Partial<FlagStatic>, nowS = Math.floor(Date.now() / 1000)): Promise<{ upserted: number; removed: number }> {
  try {
    const fresh = await scanFlags(db, st);
    const old = await readFlagCache(db);
    const stmts: D1PreparedStatement[] = []; let up = 0, rm = 0;
    for (const [id, f] of fresh) {
      const o = old.get(id);
      if (o && JSON.stringify(o) === JSON.stringify(f)) continue;
      stmts.push(db.prepare("INSERT INTO note_flags (id,d,pubkey,level,weight,tip_weight,reasons_json,computed_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET d=excluded.d, pubkey=excluded.pubkey, level=excluded.level, weight=excluded.weight, tip_weight=excluded.tip_weight, reasons_json=excluded.reasons_json, computed_at=excluded.computed_at")
        .bind(id, f.d, f.pubkey, f.level, f.weight, f.tip_weight ?? null, JSON.stringify(f.reasons), nowS)); up++;
    }
    for (const id of old.keys()) if (!fresh.has(id)) { stmts.push(db.prepare("DELETE FROM note_flags WHERE id = ?").bind(id)); rm++; }
    for (let k = 0; k < stmts.length; k += 100) await db.batch(stmts.slice(k, k + 100));
    return { upserted: up, removed: rm };
  } catch { return { upserted: 0, removed: 0 }; }
}

export async function readFlagCache(db: D1Database | undefined, d?: string): Promise<Map<string, NoteFlag>> {
  const m = new Map<string, NoteFlag>();
  if (!db) return m;
  try {
    const { results } = await db.prepare(`SELECT id,d,pubkey,level,weight,tip_weight,reasons_json FROM note_flags${d ? " WHERE d = ?" : ""}`).bind(...(d ? [d] : [])).all<Row>();
    for (const r of results ?? []) m.set(r.id, { id: r.id, d: r.d, pubkey: r.pubkey, reasons: JSON.parse(r.reasons_json), level: r.level, weight: r.weight, ...(r.tip_weight != null ? { tip_weight: r.tip_weight } : {}) });
  } catch { /* migration pending */ }
  return m;
}
