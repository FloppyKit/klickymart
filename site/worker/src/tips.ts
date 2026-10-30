/** Tips on 422 reviews / shopping-experience notes: NIP-57 zap receipts (kind 9735) whose `e` tag points at a note.
 * Display counts every receipt; ranking weight counts only DISTINCT tippers with a validated receipt, ignores self-zaps,
 * and is capped (see TIP_WEIGHT). Read-only over nostr_events; nothing is published. */
import { decodeBolt11 } from "./bolt11";
import { verifyNostrEvent } from "./nostr-verify";

export const ZAP_RECEIPT = 9735;
/** Ranking multiplier for a note: 1 + min(CAP, PER * distinct validated tippers). */
export const TIP_WEIGHT = { PER: 0.1, CAP: 0.5 };
export const tipWeight = (distinctValidated: number) => 1 + Math.min(TIP_WEIGHT.CAP, TIP_WEIGHT.PER * distinctValidated);

type Ev = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
export interface Tip { receipt: string; target: string; tipper: string | null; sats: number | null; validated: boolean; self: boolean; created_at: number }
export interface TipSummary { tips: number; sats: number; distinct_tippers: number; validated_tippers: number; self_zaps_ignored: number; weight: number }

/** One receipt -> tip. tipper = pubkey of the embedded 9734 zap request (the payer); validated = receipt and request signatures check. */
export function parseTip(r: Ev, authorOf: (id: string) => string | undefined): Tip | null {
  const target = r.tags.find((t) => t[0] === "e")?.[1];
  if (!target) return null;
  const b = r.tags.find((t) => t[0] === "bolt11")?.[1];
  const dec = b ? decodeBolt11(b) : null;
  let req: Ev | null = null;
  try { req = JSON.parse(r.tags.find((t) => t[0] === "description")?.[1] ?? "null") as Ev | null; } catch { req = null; }
  const tipper = req?.pubkey ?? r.tags.find((t) => t[0] === "P")?.[1] ?? null;
  const validated = verifyNostrEvent(r as never, ZAP_RECEIPT).ok && !!req && req.kind === 9734 && verifyNostrEvent(req as never, 9734).ok && (dec?.amount_msat ?? 0) > 0;
  const author = authorOf(target);
  return { receipt: r.id, target, tipper, sats: dec?.amount_msat != null ? Math.floor(dec.amount_msat / 1000) : null, validated, self: !!tipper && !!author && tipper === author, created_at: r.created_at };
}

export function summarize(tips: Tip[]): TipSummary {
  const nonSelf = tips.filter((t) => !t.self);
  const distinct = new Set(nonSelf.map((t) => t.tipper ?? t.receipt));
  const validated = new Set(nonSelf.filter((t) => t.validated && t.tipper).map((t) => t.tipper!));
  return { tips: nonSelf.length, sats: nonSelf.reduce((a, t) => a + (t.sats ?? 0), 0), distinct_tippers: distinct.size, validated_tippers: validated.size,
    self_zaps_ignored: tips.length - nonSelf.length, weight: tipWeight(validated.size) };
}

/** All tips on notes (optionally only notes about domain d), keyed by note id, plus per-reviewer and per-tipper (curator) views. */
export async function loadTips(db: D1Database | undefined, d?: string): Promise<{ byNote: Map<string, Tip[]>; author: Map<string, string>; noteDomain: Map<string, string> }> {
  const byNote = new Map<string, Tip[]>(); const author = new Map<string, string>(); const noteDomain = new Map<string, string>();
  if (!db) return { byNote, author, noteDomain };
  try {
    const notes = await db.prepare(`SELECT id, pubkey, d FROM experiences${d ? " WHERE d = ?" : ""}`).bind(...(d ? [d] : [])).all<{ id: string; pubkey: string; d: string }>();
    for (const n of notes.results ?? []) { author.set(n.id, n.pubkey); noteDomain.set(n.id, n.d); }
    const rv = await db.prepare(`SELECT id, pubkey, d FROM reviews${d ? " WHERE d = ?" : ""}`).bind(...(d ? [d] : [])).all<{ id: string; pubkey: string; d: string }>();
    for (const n of rv.results ?? []) { author.set(n.id, n.pubkey); noteDomain.set(n.id, n.d); }
    if (!author.size) return { byNote, author, noteDomain };
    const { results } = await db.prepare("SELECT raw_json FROM nostr_events WHERE kind = ?").bind(ZAP_RECEIPT).all<{ raw_json: string }>();
    for (const row of results ?? []) {
      const t = parseTip(JSON.parse(row.raw_json) as Ev, (id) => author.get(id));
      if (!t || !author.has(t.target)) continue;
      (byNote.get(t.target) ?? byNote.set(t.target, []).get(t.target)!).push(t);
    }
  } catch { /* migration pending */ }
  return { byNote, author, noteDomain };
}

export function perReviewer(t: Awaited<ReturnType<typeof loadTips>>) {
  const by = new Map<string, Tip[]>();
  for (const [id, tips] of t.byNote) { const a = t.author.get(id)!; (by.get(a) ?? by.set(a, []).get(a)!).push(...tips); }
  return [...by].map(([pubkey, tips]) => ({ reviewer: pubkey, notes_tipped: new Set(tips.map((x) => x.target)).size, ...summarize(tips) })).sort((a, b) => b.sats - a.sats);
}

/** Curator record: per tipper, which notes they tipped and how much (public data from the receipts). Self-zaps excluded. */
export function curators(t: Awaited<ReturnType<typeof loadTips>>) {
  const by = new Map<string, Tip[]>();
  for (const tips of t.byNote.values()) for (const x of tips) if (!x.self && x.tipper) (by.get(x.tipper) ?? by.set(x.tipper, []).get(x.tipper)!).push(x);
  return [...by].map(([tipper, tips]) => ({ tipper, tips: tips.length, sats: tips.reduce((a, x) => a + (x.sats ?? 0), 0), validated: tips.every((x) => x.validated),
    notes: [...new Set(tips.map((x) => x.target))].map((id) => ({ id, d: t.noteDomain.get(id) ?? null })) })).sort((a, b) => b.sats - a.sats);
}
