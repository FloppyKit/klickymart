import type { Snapshot } from "./index-mem";

export interface SummaryJson {
  version: string;
  generated_at: string;
  records: number;
  by_status: Record<string, number>;
  by_btc_grade: Record<string, number>;
}

export function buildSummaryJson(snap: Snapshot): SummaryJson {
  const by_status: Record<string, number> = {};
  const by_btc_grade: Record<string, number> = {
    "0": 0,
    "1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    ungraded: 0,
  };

  for (const row of snap.rows) {
    by_status[row.status] = (by_status[row.status] ?? 0) + 1;
    if (row.btc === null) by_btc_grade.ungraded += 1;
    else {
      const k = String(row.btc);
      by_btc_grade[k] = (by_btc_grade[k] ?? 0) + 1;
    }
  }

  return {
    version: snap.version,
    generated_at: new Date().toISOString(),
    records: snap.rows.length,
    by_status,
    by_btc_grade,
  };
}
