import type { RecordRow } from "./normalize";
import { discoverCrawlerPubkeyHex } from "./crawler-pubkey";

/** Packed row for in-memory filtering */
export interface IndexRow {
  idx: number;
  d: string;
  name: string | null;
  status: string;
  status_code: number;
  ts: number;
  ag: number | null;
  co: number | null;
  ease: number | null;
  guest: number | null;
  tos: string | null;
  kyc: string | null;
  btc: number | null;
  btc_any: number | null;
  cat_mask: number;
  pay_any: number;
  pay_online: number;
  pay_instore: number;
  pay_unscoped: number;
  pay_no: number;
  ar_mask: number;
  raw_json: string;
}

export interface SnapshotMeta {
  version: string;
  source: string;
  count: number;
  ts_min: number;
  ts_max: number;
  crawler_pubkey_hex?: string | null;
}

export interface Snapshot {
  version: string;
  source: string;
  rows: IndexRow[];
  meta: SnapshotMeta;
}

export function rowsToSnapshot(rows: RecordRow[], version: string, source: string): Snapshot {
  const indexRows: IndexRow[] = rows.map((r, idx) => ({
    idx,
    d: r.d,
    name: r.name,
    status: r.status,
    status_code: r.status_code,
    ts: r.ts,
    ag: r.ag,
    co: r.co,
    ease: r.ease,
    guest: r.guest,
    tos: r.tos,
    kyc: r.kyc,
    btc: r.btc,
    btc_any: r.btc_any,
    cat_mask: r.cat_mask,
    pay_any: r.pay_any,
    pay_online: r.pay_online,
    pay_instore: r.pay_instore,
    pay_unscoped: r.pay_unscoped,
    pay_no: r.pay_no,
    ar_mask: r.ar_mask,
    raw_json: r.raw_json,
  }));

  let ts_min = Infinity;
  let ts_max = -Infinity;
  for (const r of rows) {
    if (r.ts < ts_min) ts_min = r.ts;
    if (r.ts > ts_max) ts_max = r.ts;
  }
  if (!rows.length) {
    ts_min = 0;
    ts_max = 0;
  }

  const crawler_pubkey_hex = discoverCrawlerPubkeyHex(rows);

  return {
    version,
    source,
    rows: indexRows,
    meta: {
      version,
      source,
      count: rows.length,
      ts_min,
      ts_max,
      crawler_pubkey_hex,
    },
  };
}

export function snapshotFromJson(text: string): Snapshot {
  return JSON.parse(text) as Snapshot;
}

export function snapshotToJson(snap: Snapshot): string {
  return JSON.stringify(snap);
}
