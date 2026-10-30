/** Per-merchant community view from relay/POST events. Never overwrites crawl fields; weights by distinct pubkeys. */
import { NOSTR_KIND_FULFILLMENT, NOSTR_KIND_NEED } from "./nostr-kinds";
import { payLabel } from "./records-api";
import { REVIEW_NOTE } from "./reviews";
import { loadTips, perReviewer, summarize, type TipSummary } from "./tips";

export const MIN_CORROBORATING_KEYS = 2;

interface Rv { pubkey: string; created_at: number; rating: number; rating_max: number; attempt: string; pay: string | null; proof_status: string | null; source: string; relays: string | null }

export interface Community {
  baseline: string;
  reviewers: number;
  reviews_total_events: number;
  avg_rating_5: number | null;
  attempts: Record<string, number>;
  pay_reports: { pay: string; label: string; agents: number; paid_agents: number; verified_agents: number; corroborated: boolean; summary: string }[];
  verified_payments: number;
  facilitated_history?: { reviewers: number; note: string };
  handshake: { needs: number; fulfillments: number };
  other_publishers: { pubkey: string; id: string; created_at: number; relays: string[]; status: unknown; pay: unknown; btc: unknown }[];
  our_record_on_relays: { id: string; created_at: number; relays: string[] } | null;
  rules: string;
  note: string;
  tips?: TipSummary & { per_review: { id: string; tips: number; sats: number; distinct_tippers: number }[]; per_reviewer: ReturnType<typeof perReviewer>; how: string };
}

export async function getCommunity(db: D1Database | undefined, d: string, ourPubkey: string | null): Promise<Community> {
  const out: Community = {
    baseline: "KlickyMart crawl (fields above). Community data below never overwrites it.",
    reviewers: 0, reviews_total_events: 0, avg_rating_5: null, attempts: { browse: 0, cart: 0, checkout: 0, paid: 0 },
    pay_reports: [], verified_payments: 0, handshake: { needs: 0, fulfillments: 0 }, other_publishers: [], our_record_on_relays: null,
    rules: `Counts are distinct pubkeys (latest review per key). A signal needs ${MIN_CORROBORATING_KEYS}+ keys to be shown as corroborated; one key cannot change any grade.`,
    note: REVIEW_NOTE,
  };
  if (!db) return out;
  try {
    const { results } = await db.prepare("SELECT pubkey, created_at, rating, rating_max, attempt, pay, proof_status, source, relays FROM reviews WHERE d = ? ORDER BY created_at DESC").bind(d).all<Rv>();
    const all = results ?? [];
    out.reviews_total_events = all.length;
    const latest = new Map<string, Rv>();
    for (const r of all) if (!latest.has(r.pubkey)) latest.set(r.pubkey, r);
    const per = [...latest.values()];
    // verified payment from ANY of a key's reviews counts once for that key
    const verifiedKeys = new Set(all.filter((r) => r.proof_status?.startsWith("verified")).map((r) => r.pubkey));
    out.reviewers = per.length;
    out.verified_payments = verifiedKeys.size;
    const hist = new Set(all.filter((r) => r.proof_status === "facilitated-history").map((r) => r.pubkey));
    if (hist.size) out.facilitated_history = { reviewers: hist.size, note: "These reviews cite a 421 KlickyMart signed as facilitator before the store claimed its listing. Shown as history; not store-confirmed and no scoring weight." };
    if (per.length) out.avg_rating_5 = Math.round((per.reduce((a, r) => a + (r.rating * 5) / r.rating_max, 0) / per.length) * 10) / 10;
    for (const r of per) out.attempts[r.attempt] = (out.attempts[r.attempt] ?? 0) + 1;
    const pays = new Map<string, { agents: Set<string>; paid: Set<string>; verified: Set<string> }>();
    for (const r of all) {
      if (!r.pay) continue;
      const e = pays.get(r.pay) ?? { agents: new Set(), paid: new Set(), verified: new Set() };
      e.agents.add(r.pubkey);
      if (r.attempt === "paid") e.paid.add(r.pubkey);
      if (r.proof_status?.startsWith("verified")) e.verified.add(r.pubkey);
      pays.set(r.pay, e);
    }
    out.pay_reports = [...pays.entries()].map(([pay, e]) => {
      const label = payLabel(pay); const n = e.agents.size; const corroborated = n >= MIN_CORROBORATING_KEYS;
      const verb = e.paid.size ? "worked" : "offered";
      return {
        pay, label, agents: n, paid_agents: e.paid.size, verified_agents: e.verified.size, corroborated,
        summary: `agents report: ${label} ${verb} (${n} agent${n === 1 ? "" : "s"}, ${e.verified.size} verified)${corroborated ? "" : " · single report, not corroborated"}`,
      };
    }).sort((a, b) => b.agents - a.agents);
    const hs = await db.prepare("SELECT kind, COUNT(DISTINCT pubkey) AS n FROM nostr_events WHERE d = ? AND kind IN (?, ?) GROUP BY kind").bind(d, NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT).all<{ kind: number; n: number }>();
    for (const r of hs.results ?? []) { if (r.kind === NOSTR_KIND_NEED) out.handshake.needs = r.n; else out.handshake.fulfillments = r.n; }
    const recs = await db.prepare("SELECT pubkey, id, created_at, raw_json, relays FROM site_records WHERE d = ?").bind(d).all<{ pubkey: string; id: string; created_at: number; raw_json: string; relays: string }>();
    for (const r of recs.results ?? []) {
      if (r.pubkey === ourPubkey) { out.our_record_on_relays = { id: r.id, created_at: r.created_at, relays: r.relays.split(",") }; continue; }
      let c: Record<string, unknown> = {};
      try { c = JSON.parse((JSON.parse(r.raw_json) as { content: string }).content) as Record<string, unknown>; } catch { /* */ }
      out.other_publishers.push({ pubkey: r.pubkey, id: r.id, created_at: r.created_at, relays: r.relays.split(","), status: c.status ?? null, pay: c.pay ?? null, btc: c.btc ?? null });
    }
  } catch {
    /* migration pending */
  }
  try {
    const t = await loadTips(db, d);
    if (t.byNote.size) out.tips = { ...summarize([...t.byNote.values()].flat()),
      per_review: [...t.byNote].map(([id, x]) => { const s = summarize(x); return { id, tips: s.tips, sats: s.sats, distinct_tippers: s.distinct_tippers }; }),
      per_reviewer: perReviewer(t), how: "Zap (NIP-57) a useful 422 or shopping note to tip its author. Distinct validated tippers add up to +50% weight to that note on /chart; self-zaps are ignored." };
  } catch { /* ignore */ }
  return out;
}

export async function ingestStats(db: D1Database | undefined, ourPubkey: string | null, relays: string[], now = Date.now()) {
  const nowS = Math.floor(now / 1000);
  const out: Record<string, unknown> = { generated_at: new Date(now).toISOString(), relays: {}, by_kind: {}, our_31420_seen: 0, our_31420_by_relay: {}, other_31420_records: 0, reviews: { relay: 0, post: 0 } };
  if (!db) return out;
  try {
    const st = await db.prepare("SELECT * FROM ingest_state").all<{ relay: string; last_seen: number; last_event_at: number | null; last_ok_at: number | null; last_error: string | null; last_error_at: number | null; events_total: number; rejected: number }>();
    const rel: Record<string, unknown> = {};
    for (const url of relays) rel[url] = { connected_ok_at: null, events_total: 0 };
    for (const r of st.results ?? []) {
      rel[r.relay] = {
        last_seen_created_at: r.last_seen, last_event_at: r.last_event_at, last_ok_at: r.last_ok_at,
        lag_s: r.last_ok_at ? nowS - r.last_ok_at : null, events_total: r.events_total, rejected: r.rejected,
        last_error: r.last_error, last_error_at: r.last_error_at,
      };
    }
    out.relays = rel;
    const k = await db.prepare("SELECT kind, COUNT(*) AS n FROM nostr_events GROUP BY kind").all<{ kind: number; n: number }>();
    out.by_kind = Object.fromEntries((k.results ?? []).map((r) => [String(r.kind), r.n]));
    if (ourPubkey) {
      const o = await db.prepare("SELECT COUNT(*) AS n FROM site_records WHERE pubkey = ?").bind(ourPubkey).first<{ n: number }>();
      out.our_31420_seen = o?.n ?? 0;
      const by: Record<string, number> = {};
      for (const url of relays) {
        const r = await db.prepare("SELECT COUNT(DISTINCT d) AS n FROM nostr_events WHERE kind = 31420 AND pubkey = ? AND (',' || relays || ',') LIKE ?").bind(ourPubkey, `%,${url},%`).first<{ n: number }>();
        by[url] = r?.n ?? 0;
      }
      out.our_31420_by_relay = by;
      const t = await db.prepare("SELECT COUNT(*) AS n FROM site_records WHERE pubkey != ?").bind(ourPubkey).first<{ n: number }>();
      out.other_31420_records = t?.n ?? 0;
    }
    const rv = await db.prepare("SELECT source, COUNT(*) AS n FROM reviews GROUP BY source").all<{ source: string; n: number }>();
    out.reviews = Object.fromEntries((rv.results ?? []).map((r) => [r.source, r.n]));
  } catch (e) {
    out.error = "ingest tables not ready";
  }
  return out;
}
