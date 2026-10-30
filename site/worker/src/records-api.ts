import type { IndexRow } from "./index-mem";
import { anJson } from "./agent-native";
import { maskToArCodes, maskToPayCodes, PAY_GROUPS, PAY_LABELS } from "./codes";

export interface CompactRecord {
  d: string;
  name: string | null;
  url: string;
  status: string;
  ag: number | null;
  co: number | null;
  ease: number | null;
  tos: string | null;
  btc: number | null;
  btc_any: boolean;
  pay: {
    online: string[];
    instore: string[];
    unscoped: string[];
    all: string[];
    no: string[];
  };
  ar: string[];
  evidence: Record<string, unknown>;
  ts: number;
  v: string;
  record: string;
  /** present only for agent-native stores (2026-10-30) */
  agent_native?: Record<string, unknown>;
}

export function parseRaw(raw_json: string): Record<string, unknown> {
  return JSON.parse(raw_json) as Record<string, unknown>;
}

export function recordUrl(origin: string, d: string): string {
  return `${origin}/records/${encodeURIComponent(d)}`;
}

export function merchantUrl(origin: string, d: string): string {
  return `${origin}/merchant/${encodeURIComponent(d)}`;
}

export function rowToCompact(row: IndexRow, origin: string): CompactRecord {
  const raw = parseRaw(row.raw_json);
  const payOnline = Array.isArray(raw.pay_online) ? raw.pay_online.filter((x): x is string => typeof x === "string") : [];
  const payInstore = Array.isArray(raw.pay_instore) ? raw.pay_instore.filter((x): x is string => typeof x === "string") : [];
  const payUnscoped = Array.isArray(raw.pay_unscoped) ? raw.pay_unscoped.filter((x): x is string => typeof x === "string") : [];
  const payAll = Array.isArray(raw.pay) ? raw.pay.filter((x): x is string => typeof x === "string") : [];
  const payNo = Array.isArray(raw.pay_no) ? raw.pay_no.filter((x): x is string => typeof x === "string") : [];

  const pay_q = Array.isArray(raw.pay_q) ? raw.pay_q : [];
  const evidence: Record<string, unknown> = {
    pay: pay_q,
    tos: raw.tos_url ? { url: raw.tos_url, q: raw.tos_q ?? null } : undefined,
    name: raw.name_ev ?? null,
  };

  return {
    d: row.d,
    name: row.name,
    url: `https://${row.d}/`,
    status: row.status,
    ag: row.ag,
    co: row.co,
    ease: row.ease,
    tos: row.tos,
    btc: row.btc,
    btc_any: row.btc_any === 1 || (row.btc !== null && row.btc > 0),
    pay: {
      online: payOnline,
      instore: payInstore,
      unscoped: payUnscoped,
      all: payAll,
      no: payNo,
    },
    ar: maskToArCodes(row.ar_mask),
    evidence,
    ts: row.ts,
    v: typeof raw.v === "string" ? raw.v : "0.3-draft",
    record: recordUrl(origin, row.d),
    ...(anJson(row.d) ? { agent_native: anJson(row.d)! } : {}),
  };
}

export function acceptsBitcoin(row: IndexRow): boolean {
  if (row.btc !== null && row.btc >= 1) return true;
  if (row.btc_any === 1) return true;
  return (row.pay_any & PAY_GROUPS.bitcoin) !== 0;
}

export function computeStats(rows: IndexRow[]): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  const btcHist: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, ungraded: 0 };
  const agDist: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, unknown: 0 };
  const payCounts: Record<string, { online: number; instore: number; unscoped: number }> = {};
  const arCounts: Record<string, number> = {};
  const bitcoinAccepting: { d: string; name: string | null; btc: number | null }[] = [];

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const bk = row.btc === null ? "ungraded" : String(row.btc);
    btcHist[bk] = (btcHist[bk] ?? 0) + 1;

    if (row.ag === null || row.ag === undefined) agDist.unknown = (agDist.unknown ?? 0) + 1;
    else agDist[String(row.ag)] = (agDist[String(row.ag)] ?? 0) + 1;

    if (acceptsBitcoin(row)) {
      bitcoinAccepting.push({ d: row.d, name: row.name, btc: row.btc });
    }

    const raw = parseRaw(row.raw_json);
    for (const scope of ["online", "instore", "unscoped"] as const) {
      const list = raw[`pay_${scope}`];
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (typeof c !== "string") continue;
        const base = c.split(":")[0]!;
        if (!payCounts[base]) payCounts[base] = { online: 0, instore: 0, unscoped: 0 };
        payCounts[base][scope === "instore" ? "instore" : scope === "online" ? "online" : "unscoped"]++;
      }
    }

    for (const c of maskToArCodes(row.ar_mask)) {
      arCounts[c] = (arCounts[c] ?? 0) + 1;
    }
  }

  bitcoinAccepting.sort((a, b) => a.d.localeCompare(b.d));

  return {
    by_status: byStatus,
    btc_histogram: btcHist,
    ag_distribution: agDist,
    pay_counts: payCounts,
    ar_counts: arCounts,
    bitcoin_accepting: bitcoinAccepting,
    records: rows.length,
  };
}

export function payLabel(code: string): string {
  const [base, sub] = code.split(":") as [string, string | undefined];
  const label = PAY_LABELS[base] ?? code;
  if (!sub || !PAY_LABELS[base]) return label;
  return `${label} (${sub.charAt(0).toUpperCase()}${sub.slice(1)})`;
}

/** Display labels for a merchant's pay codes, de-duplicated by label (a code can sit in online and in-store lists). */
export function uniquePayLabels(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    const l = payLabel(c);
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

export function suggestDomains(rows: IndexRow[], domain: string, limit = 5): string[] {
  const lower = domain.toLowerCase();
  return rows
    .map((r) => r.d)
    .filter((d) => d.startsWith(lower.slice(0, 3)) || d.includes(lower))
    .slice(0, limit);
}
