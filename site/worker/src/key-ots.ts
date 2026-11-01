/**
 * M3 OpenTimestamps (OTS) for the signing-key lifecycle (Satoshi OTS rules, Matt 2026-11-01). Switch: KM_KEY_OTS
 * (default OFF). With it off nothing here runs and the lifecycle behaves exactly as before.
 *
 * What it adds:
 *  - every key statement, revoke and revocation-key rotation is stamped (digest = the record hash); the proofs are stored
 *    beside the record and upgraded by the existing daily cron once a calendar has put them in a block. Stamping never
 *    blocks signing: it runs in the background and a failure just leaves the record unstamped;
 *  - every lifecycle record may embed `notbefore` = a recent Bitcoin block {height, hash}; a record whose CONFIRMED
 *    anchor height is more than FRESH_K blocks after its notbefore is stale and invalid;
 *  - ordering by block HEIGHTS only (never block timestamps): A is strictly before B iff anchor(A) < notbefore(B);
 *  - the old-revocation-key dispute rule (rule 6/7) implemented by judgeOldKeyRevoke.
 *
 * Proof verification is an INJECTED interface (OtsProofVerifier): no OTS library is bundled. The candidates
 * (opentimestamps/javascript-opentimestamps) pull bitcore-lib and network code into a Worker bundle; Satoshi's rule
 * allowed an interface + mock instead. A real verifier must parse the .ots operations from the digest to a Bitcoin
 * block-header attestation and return that block's height and hash; this module then checks the hash against the
 * injected header source(s) and the confirmation depth. PENDING: a real minimal .ots parser/verifier and calendar client.
 * Nothing here contacts a calendar or a Bitcoin node by itself, and nothing is published (no NIP-03 kind 1040 events).
 */

/** An anchor counts only with at least this many confirmations (block at height h counts 1 when tip = h). */
export const CONF = 6;
export const FRESH_K_DEFAULT = 36;
/** Compiled ceiling for FRESH_K: 144 (~1 day of blocks; Satoshi confirmed 2026-11-01).
 * TODO(measure): real calendar-submit -> block-inclusion latency (incl. calendar aggregation delay) to set FRESH_K. */
export const FRESH_K_MAX = 144;
export function effectiveFreshK(config?: number | string | null): number {
  const n = typeof config === "string" ? (/^\d+$/.test(config.trim()) ? Number(config.trim()) : NaN) : config ?? NaN;
  return Number.isSafeInteger(n) && (n as number) > 0 ? Math.min(FRESH_K_MAX, n as number) : FRESH_K_DEFAULT;
}

export interface NotBefore { height: number; hash: string }
export const validNotBefore = (nb: unknown): nb is NotBefore => !!nb && typeof nb === "object" && Object.keys(nb).sort().join() === "hash,height" && Number.isSafeInteger((nb as NotBefore).height) && (nb as NotBefore).height >= 0 && /^[0-9a-f]{64}$/.test((nb as NotBefore).hash);

/** Bitcoin block headers, injected. More than one source allowed (combineHeaderSources). */
export interface BlockHeaderSource { header(height: number): { hash: string } | null; tip(): number | null }
/** A header counts only if every source that answers agrees (and at least one answers); tip = the lowest reported tip. */
export function combineHeaderSources(srcs: BlockHeaderSource[]): BlockHeaderSource {
  return {
    header(h) {
      const got = srcs.map((s) => { try { return s.header(h); } catch { return null; } }).filter((x): x is { hash: string } => !!x);
      if (!got.length || new Set(got.map((g) => g.hash)).size > 1) return null;
      return got[0]!;
    },
    tip() {
      const t = srcs.map((s) => { try { return s.tip(); } catch { return null; } }).filter((x): x is number => Number.isSafeInteger(x));
      return t.length ? Math.min(...t) : null;
    },
  };
}

export interface OtsAttestation { height: number; block_hash: string }
/** Verifies that `proof` commits `digestHex` into a Bitcoin block; returns that block, or null. Injected. */
export interface OtsProofVerifier { verify(proof: string, digestHex: string): OtsAttestation | null }

export interface OtsContext {
  proofs: Record<string, string[]>;      // record hash -> stored proofs
  verifier: OtsProofVerifier;
  headers: BlockHeaderSource | null;     // null = no headers: every anchor is unconfirmed
  freshK?: number | string;
}

/** Lowest confirmed anchor height for a record, or null (unstamped, pending, unverifiable, < CONF, or no headers). */
export function anchorOf(ctx: OtsContext, hash: string): number | null {
  const H = ctx.headers; if (!H) return null;
  const tip = H.tip(); if (tip === null) return null;
  let best: number | null = null;
  for (const p of ctx.proofs[hash] ?? []) {
    let a: OtsAttestation | null = null;
    try { a = ctx.verifier.verify(p, hash); } catch { a = null; }
    if (!a || !Number.isSafeInteger(a.height)) continue;
    const h = H.header(a.height);
    if (!h || h.hash !== a.block_hash) continue;
    if (tip - a.height + 1 < CONF) continue;
    if (best === null || a.height < best) best = a.height;
  }
  return best;
}

/** notbefore height if its hash matches the header at that height; "invalid" on mismatch; null if missing or unknown. */
export function notBeforeOf(ctx: OtsContext, nb: NotBefore | undefined): number | "invalid" | null {
  if (!nb) return null;
  const h = ctx.headers?.header(nb.height) ?? null;
  if (!h) return null;
  return h.hash === nb.hash ? nb.height : "invalid";
}

export type OtsCheck = "ok" | "reject" | "stale" | "eclipsed";
/** Per-record OTS check (Satoshi OTS answers 2-4).
 *  - no notbefore: "ok" (a pre-OTS record is unbounded: valid chain history, never ordered against anything);
 *  - reject outright: notbefore height more than CONF above the tip, or its hash disagrees with a known header;
 *  - eclipsed: no header source knows the notbefore block by firstSeenTip + FRESH_K + CONF;
 *  - stale: confirmed anchor more than FRESH_K blocks after notbefore, or anchored before it.
 * Callers decide who is exempt (current-key revokes are exempt from stale; see evaluate). */
export function otsCheck(ctx: OtsContext, hash: string, nb: NotBefore | undefined, firstSeenTip?: number): OtsCheck {
  if (!nb) return "ok";
  const tip = ctx.headers?.tip() ?? null;
  if (tip !== null && nb.height > tip + CONF) return "reject";
  const h = ctx.headers?.header(nb.height) ?? null;
  if (h && h.hash !== nb.hash) return "reject";
  const K = effectiveFreshK(ctx.freshK);
  if (!h) return tip !== null && firstSeenTip !== undefined && tip >= firstSeenTip + K + CONF ? "eclipsed" : "ok";
  const a = anchorOf(ctx, hash);
  if (a === null) return "ok";
  return a - nb.height > K || a < nb.height ? "stale" : "ok";
}
/** Back-compat helper: anything but "ok". */
export const isStale = (ctx: OtsContext, hash: string, nb: NotBefore | undefined, firstSeenTip?: number) => otsCheck(ctx, hash, nb, firstSeenTip) !== "ok";

/** Rule 3: A strictly before B iff anchor(A) < notbefore(B) (heights only). Both must carry notbefore: an unbounded
 * (pre-OTS) record is never strictly before or after anything. */
export function strictlyBefore(ctx: OtsContext, a: { hash: string; notbefore?: NotBefore }, b: { notbefore?: NotBefore }): boolean {
  if (!a.notbefore || !b.notbefore) return false;
  const x = anchorOf(ctx, a.hash), n = notBeforeOf(ctx, b.notbefore);
  return x !== null && typeof n === "number" && x < n;
}

export type RevokeJudgement = "valid" | "stale" | "pending";
/** Rules 6 + 7: a revoke by the OLD revocation key R1 against the rotation R1 -> R2.
 *  - revoke strictly before the rotation -> valid (terminal);
 *  - rotation strictly before the revoke -> stale (ignored; the revoke was never valid);
 *  - both anchors confirmed but neither strictly first (tie / overlapping windows) -> valid (revoke wins);
 *  - otherwise pending (fail closed) until both are confirmed, or until the tip reaches the newest embedded notbefore +
 *    FRESH_K + CONF, after which an unanchored record is stale: unanchored revoke -> stale; unanchored rotation -> the
 *    rotation is stale, so the revoke stands (valid). No headers -> pending forever (fail closed in the dispute only). */
export function judgeOldKeyRevoke(ctx: OtsContext, rev: { hash: string; payload: { notbefore?: NotBefore } }, rot: { hash: string; payload: { notbefore?: NotBefore } }): RevokeJudgement {
  // Unbounded (pre-OTS) side: never ordered, so the tie rule applies: the revoke wins.
  if (!rev.payload.notbefore || !rot.payload.notbefore) return "valid";
  if (strictlyBefore(ctx, { hash: rev.hash, notbefore: rev.payload.notbefore }, rot.payload)) return "valid";
  if (strictlyBefore(ctx, { hash: rot.hash, notbefore: rot.payload.notbefore }, rev.payload)) return "stale";
  const aR = anchorOf(ctx, rev.hash), aX = anchorOf(ctx, rot.hash);
  if (aR !== null && aX !== null) return "valid";
  const tip = ctx.headers?.tip() ?? null;
  const nbs = [notBeforeOf(ctx, rev.payload.notbefore), notBeforeOf(ctx, rot.payload.notbefore)].filter((x): x is number => typeof x === "number");
  if (tip !== null && nbs.length) {
    if (tip >= Math.max(...nbs) + effectiveFreshK(ctx.freshK) + CONF) return aR === null ? "stale" : "valid";
  }
  return "pending";
}

// ---------------- Worker side: stamping + upgrade (flag KM_KEY_OTS) ----------------

export function otsEnabled(env: { KM_KEY_OTS?: string }): boolean {
  const v = (env.KM_KEY_OTS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on"; // default OFF
}
/** An OTS calendar client, injected (none is bundled; tests use mocks). stamp -> pending proof; upgrade -> complete
 * proof once the calendar's commitment is in a block, else null. */
export interface OtsCalendar { stamp(digestHex: string): Promise<string>; upgrade(proof: string): Promise<string | null> }

/** Stamp one record on every calendar; store whatever proofs come back. Never throws. */
export async function stampRecord(db: D1Database, hash: string, calendars: OtsCalendar[], nowS: number): Promise<number> {
  const proofs: string[] = [];
  for (const c of calendars) { try { const p = await c.stamp(hash); if (typeof p === "string" && p) proofs.push(p); } catch { /* unstamped on this calendar */ } }
  if (!proofs.length) return 0;
  try {
    await db.prepare("INSERT OR IGNORE INTO km_key_ots (rec_hash, proofs_json, status, updated_at) VALUES (?,?,'pending',?)").bind(hash, JSON.stringify(proofs), nowS).run();
  } catch { return 0; }
  return proofs.length;
}
/** Fire-and-forget wrapper: signing never waits on this. */
export function stampInBackground(waitUntil: ((p: Promise<unknown>) => void) | undefined, db: D1Database, hash: string, calendars: OtsCalendar[], nowS: number): void {
  if (!calendars.length) return;
  const p = stampRecord(db, hash, calendars, nowS).catch(() => 0);
  if (waitUntil) waitUntil(p);
}
/** Daily cron: try to upgrade every pending proof (one pass, no polling). A row becomes 'upgraded' once any proof does. */
export async function upgradeStamps(db: D1Database, calendars: OtsCalendar[], nowS: number): Promise<number> {
  if (!calendars.length) return 0;
  let n = 0;
  try {
    const { results } = await db.prepare("SELECT rec_hash, proofs_json FROM km_key_ots WHERE status = 'pending'").all<{ rec_hash: string; proofs_json: string }>();
    for (const r of results ?? []) {
      const proofs = JSON.parse(r.proofs_json) as string[];
      let up = false;
      for (let i = 0; i < proofs.length; i++) {
        for (const c of calendars) {
          try { const u = await c.upgrade(proofs[i]!); if (u) { proofs[i] = u; up = true; break; } } catch { /* stays pending */ }
        }
      }
      if (up) { await db.prepare("UPDATE km_key_ots SET proofs_json = ?, status = 'upgraded', updated_at = ? WHERE rec_hash = ?").bind(JSON.stringify(proofs), nowS, r.rec_hash).run(); n++; }
    }
  } catch { /* next daily run */ }
  return n;
}
export async function loadOtsProofs(db: D1Database): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  try {
    const { results } = await db.prepare("SELECT rec_hash, proofs_json FROM km_key_ots ORDER BY rec_hash").all<{ rec_hash: string; proofs_json: string }>();
    for (const r of results ?? []) out[r.rec_hash] = JSON.parse(r.proofs_json) as string[];
  } catch { /* none */ }
  return out;
}

/** OTS activation (answer 3). null = OTS never activated (records without notbefore are accepted as before). */
export async function otsActivation(db: D1Database): Promise<{ stmt: string; at: number } | null> {
  try { const r = await db.prepare("SELECT v FROM km_key_ots_state WHERE k = 'activated'").first<{ v: string }>(); return r ? JSON.parse(r.v) : null; } catch { return null; }
}
/** Called only from the daily cron run that just promoted `stmtHash` (which must carry notbefore). Idempotent. */
export async function activateOts(db: D1Database, stmtHash: string, nowS: number): Promise<boolean> {
  try {
    const r = await db.prepare("SELECT body_json FROM km_key_records WHERE rec_hash = ? AND kind = 'statement'").bind(stmtHash).first<{ body_json: string }>();
    if (!r || !validNotBefore(JSON.parse(r.body_json)?.payload?.notbefore)) return false;
    await db.prepare("INSERT OR IGNORE INTO km_key_ots_state (k, v) VALUES ('activated', ?)").bind(JSON.stringify({ stmt: stmtHash, at: nowS })).run();
    return true;
  } catch { return false; }
}
