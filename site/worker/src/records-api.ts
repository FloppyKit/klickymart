import type { IndexRow } from "./index-mem";
import { maskToArCodes, maskToPayCodes, PAY_LABELS } from "./codes";

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
  };
}

export function computeStats(rows: IndexRow[]): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  const btcHist: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, null: 0 };
  const payCounts: Record<string, { online: number; instore: number; unscoped: number }> = {};
  const arCounts: Record<string, number> = {};

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const bk = row.btc === null ? "null" : String(row.btc);
    btcHist[bk] = (btcHist[bk] ?? 0) + 1;

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

  return {
    by_status: byStatus,
    btc_histogram: btcHist,
    pay_counts: payCounts,
    ar_counts: arCounts,
    records: rows.length,
  };
}

export function payLabel(code: string): string {
  const base = code.split(":")[0]!;
  return PAY_LABELS[base] ?? code;
}

export function suggestDomains(rows: IndexRow[], domain: string, limit = 5): string[] {
  const lower = domain.toLowerCase();
  return rows
    .map((r) => r.d)
    .filter((d) => d.startsWith(lower.slice(0, 3)) || d.includes(lower))
    .slice(0, limit);
}
