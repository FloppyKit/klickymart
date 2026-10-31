/**
 * R11-002: shape validation for crawler-supplied policy arrays. Used at ingest (normalize) and at render
 * (policiesOf), so a malformed record (e.g. return_restrictions: [null]) drops the bad entries instead of crashing.
 */
export type ReturnRestriction = { kind: string; q: string; url?: string };
export type ConflictingSource = { days: number; q: string; url?: string };

const str = (v: unknown, max = 2000): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const url = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\/[^\s"<>]+$/i.test(v) && v.length <= 2048 ? v : undefined);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** null when not an array (not extracted); otherwise only the valid entries. */
export function cleanRestrictions(v: unknown): ReturnRestriction[] | null {
  if (!Array.isArray(v)) return null;
  const out: ReturnRestriction[] = [];
  for (const x of v.slice(0, 50)) {
    if (!obj(x) || !str(x.kind, 100) || !str(x.q)) continue;
    const u = url(x.url);
    out.push({ kind: x.kind, q: x.q, ...(u ? { url: u } : {}) });
  }
  return out;
}

export function cleanConflicts(v: unknown): ConflictingSource[] | null {
  if (!Array.isArray(v)) return null;
  const out: ConflictingSource[] = [];
  for (const x of v.slice(0, 50)) {
    if (!obj(x) || typeof x.days !== "number" || !Number.isFinite(x.days) || x.days < 0 || x.days > 3650 || !str(x.q)) continue;
    const u = url(x.url);
    out.push({ days: x.days, q: x.q, ...(u ? { url: u } : {}) });
  }
  return out;
}

/** Returns a copy of policies with both arrays cleaned (absent stays absent; non-arrays are removed). */
export function cleanPolicies(p: unknown): Record<string, unknown> | null {
  if (!obj(p)) return null;
  const out: Record<string, unknown> = { ...p };
  for (const [k, f] of [["return_restrictions", cleanRestrictions], ["conflicting_sources", cleanConflicts]] as const) {
    if (!(k in out)) continue;
    const c = f(out[k]);
    if (c === null) delete out[k]; else out[k] = c;
  }
  return out;
}

/** Ingest-side: a raw record with policies cleaned (policies that are not an object are dropped). */
export function sanitizeRawPolicies<T extends Record<string, unknown>>(raw: T): T {
  if (!("policies" in raw)) return raw;
  const c = cleanPolicies(raw.policies);
  const out = { ...raw } as Record<string, unknown>;
  if (c) out.policies = c; else delete out.policies;
  return out as T;
}
