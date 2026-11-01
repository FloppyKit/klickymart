/**
 * Ingest hook for the 420/421/422 validator: MARKS ONLY. Stores factual marks in handshake_marks; nothing that ranks or
 * hides anything reads that table. Kill switch: KM_HANDSHAKE_MARKS = "0" | "false" | "off" disables it, and then the
 * validator is not called at all. Default on.
 */
import { checkThreads, type NostrEventLine } from "./handshake";
import { NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE } from "./nostr-kinds";

const KINDS = new Set<number>([NOSTR_KIND_NEED, NOSTR_KIND_FULFILLMENT, NOSTR_KIND_ACCEPTANCE]);

export function handshakeMarksEnabled(env: { KM_HANDSHAKE_MARKS?: string }): boolean {
  const v = (env.KM_HANDSHAKE_MARKS ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** Mark handshake events in a batch (refs looked up in nostr_events). `checker` is injectable for tests. Never throws. */
export async function recordHandshakeMarks(db: D1Database, evs: NostrEventLine[], nowS: number, checker: typeof checkThreads = checkThreads): Promise<number> {
  const mine = evs.filter((e) => KINDS.has(e.kind));
  if (!mine.length) return 0;
  try {
    const have = new Map(mine.map((e) => [e.id, e]));
    const refs = [...new Set(mine.flatMap((e) => e.tags.filter((t) => t[0] === "e" && (t[3] === "need" || t[3] === "fulfillment")).map((t) => t[1])))].filter((id) => id && !have.has(id)).slice(0, 200);
    const ctx: NostrEventLine[] = [];
    for (let i = 0; i < refs.length; i += 50) {
      const chunk = refs.slice(i, i + 50);
      const { results } = await db.prepare(`SELECT raw_json FROM nostr_events WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ raw_json: string }>();
      for (const r of results ?? []) ctx.push(JSON.parse(r.raw_json) as NostrEventLine);
    }
    // Signatures were already verified by validateRelayEvent; stored refs were verified when stored.
    const rep = checker([...ctx, ...mine], { checkSig: false });
    const stmts = mine.map((e) => { const x = rep.byId.get(e.id)!; return db.prepare("INSERT OR REPLACE INTO handshake_marks (event_id,kind,valid,marks,checked_at) VALUES (?,?,?,?,?)").bind(e.id, e.kind, x.result.ok ? 1 : 0, JSON.stringify(x.marks), nowS); });
    await db.batch(stmts);
    return stmts.length;
  } catch { return 0; } // marks are best-effort; never block ingest
}

export async function getHandshakeMarks(db: D1Database, id: string): Promise<{ valid: boolean; marks: string[] } | null> {
  const r = await db.prepare("SELECT valid, marks FROM handshake_marks WHERE event_id = ?").bind(id).first<{ valid: number; marks: string }>();
  return r ? { valid: r.valid === 1, marks: JSON.parse(r.marks) as string[] } : null;
}
