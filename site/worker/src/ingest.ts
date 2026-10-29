import type { RecordRow, RawRecord } from "./normalize";
import { normalize, rejectExampleUnlessAllowed } from "./normalize";
import { rowsToSnapshot, snapshotToJson, type Snapshot } from "./index-mem";
import { parseRecordLine, type NostrEventLine } from "./nostr-record-source";
import { verifyNostr31420Event } from "./nostr-verify";

export interface RecordSource {
  name: string;
  read(): AsyncIterable<RawRecord>;
}

export class NdjsonFileSource implements RecordSource {
  name = "ndjson-file";
  constructor(private text: string) {}

  async *read(): AsyncIterable<RawRecord> {
    for (const line of this.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const rec = parseRecordLine(trimmed);
      if (rec) yield rec;
    }
  }
}

export { Nostr31420NdjsonSource } from "./nostr-record-source";

/** In-memory source for tests (swap-ability) */
export class ArrayRecordSource implements RecordSource {
  name = "array";
  constructor(private records: RawRecord[]) {}

  async *read(): AsyncIterable<RawRecord> {
    for (const r of this.records) yield r;
  }
}

export interface IngestOptions {
  allowSynthetic?: boolean;
  sourceLabel?: string;
  /** When true, kind 31420 lines must pass NIP-01 id + Schnorr verify. */
  verifyEvents?: boolean;
}

export interface IngestReport {
  source: string;
  read: number;
  upserted: number;
  rejected: { line: number; d: string | null; reason: string }[];
  version: string;
  ms: number;
}

function hashSource(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function ingestFromNdjsonText(
  text: string,
  opts: IngestOptions & { contentHash?: string } = {},
): Promise<{ rows: Map<string, RecordRow>; report: IngestReport }> {
  const sideRejected: IngestReport["rejected"] = [];
  async function* linesWithReject(): AsyncIterable<RawRecord> {
    let lineNum = 0;
    for (const line of text.split("\n")) {
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: NostrEventLine | RawRecord;
      try {
        parsed = JSON.parse(trimmed) as NostrEventLine | RawRecord;
      } catch {
        throw new Error(`line ${lineNum}: invalid JSON`);
      }

      if (opts.verifyEvents && typeof (parsed as NostrEventLine).kind === "number") {
        const ev = parsed as NostrEventLine;
        const v = verifyNostr31420Event(ev);
        if (!v.ok) {
          sideRejected.push({ line: lineNum, d: tagDomain(ev.tags), reason: v.reason });
          continue;
        }
      }

      try {
        const rec = parseRecordLine(trimmed);
        if (rec) yield rec;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`line ${lineNum}: ${msg}`);
      }
    }
  }

  const { rows, report } = await ingestFromLines(linesWithReject(), opts);
  if (sideRejected.length) {
    report.rejected.push(...sideRejected);
  }
  return { rows, report };
}

function tagDomain(tags: string[][] | undefined): string | null {
  if (!tags) return null;
  for (const t of tags) {
    if (t[0] === "d" && typeof t[1] === "string") return t[1];
  }
  return null;
}

export async function ingestFromLines(
  lines: AsyncIterable<RawRecord>,
  opts: IngestOptions & { contentHash?: string },
): Promise<{ rows: Map<string, RecordRow>; report: IngestReport }> {
  const t0 = Date.now();
  const byDomain = new Map<string, RecordRow>();
  const rejected: IngestReport["rejected"] = [];
  let read = 0;
  let lineNum = 0;
  const ingestedAt = Math.floor(Date.now() / 1000);
  const sourcePrefix = opts.sourceLabel ?? "file";

  for await (const raw of lines) {
    lineNum++;
    read++;
    const dPreview = typeof raw.d === "string" ? raw.d : null;
    const exampleReject = dPreview ? rejectExampleUnlessAllowed(dPreview.toLowerCase(), !!opts.allowSynthetic) : null;
    if (exampleReject) {
      rejected.push({ line: lineNum, d: dPreview, reason: exampleReject });
      continue;
    }

    const source = `${sourcePrefix}:${opts.contentHash ?? "inline"}`;
    const result = normalize(raw, source, ingestedAt);
    if (!result.ok) {
      rejected.push({ line: lineNum, d: dPreview, reason: result.reason });
      continue;
    }

    const existing = byDomain.get(result.row.d);
    if (!existing || result.row.ts >= existing.ts) {
      byDomain.set(result.row.d, result.row);
    }
  }

  const version = `${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}#${opts.contentHash ?? hashSource(String(read))}`;
  const ms = Date.now() - t0;

  return {
    rows: byDomain,
    report: {
      source: `${sourcePrefix}:${opts.contentHash ?? "inline"}`,
      read,
      upserted: byDomain.size,
      rejected,
      version,
      ms,
    },
  };
}

export function buildSnapshotFromMap(rows: Map<string, RecordRow>, version: string, source: string): Snapshot {
  const list = [...rows.values()].sort((a, b) => a.d.localeCompare(b.d));
  return rowsToSnapshot(list, version, source);
}

export interface EnvLike {
  DB?: D1Database;
  KV?: KVNamespace;
}

export async function persistIngest(
  rows: Map<string, RecordRow>,
  report: IngestReport,
  env: EnvLike,
): Promise<Snapshot> {
  const snap = buildSnapshotFromMap(rows, report.version, report.source);

  if (env.DB) {
    for (const row of rows.values()) {
      await env.DB.prepare(`
        INSERT INTO records (
          d, name, name_ev, status, status_code, ts, v, cat_mask, ag, co, steps, guest, kyc, tos, tos_url, tos_q,
          btc, btc_any, btc_conf, conf, pay_any, pay_online, pay_instore, pay_unscoped, pay_no, ar_mask, anw_type,
          ease, search, raw_json, source, event_id, pubkey, sig, ingested_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(d) DO UPDATE SET
          name=excluded.name, name_ev=excluded.name_ev, status=excluded.status, status_code=excluded.status_code,
          ts=excluded.ts, v=excluded.v, cat_mask=excluded.cat_mask, ag=excluded.ag, co=excluded.co, steps=excluded.steps,
          guest=excluded.guest, kyc=excluded.kyc, tos=excluded.tos, tos_url=excluded.tos_url, tos_q=excluded.tos_q,
          btc=excluded.btc, btc_any=excluded.btc_any, btc_conf=excluded.btc_conf, conf=excluded.conf,
          pay_any=excluded.pay_any, pay_online=excluded.pay_online, pay_instore=excluded.pay_instore,
          pay_unscoped=excluded.pay_unscoped, pay_no=excluded.pay_no, ar_mask=excluded.ar_mask, anw_type=excluded.anw_type,
          ease=excluded.ease, search=excluded.search, raw_json=excluded.raw_json, source=excluded.source,
          event_id=excluded.event_id, pubkey=excluded.pubkey, sig=excluded.sig, ingested_at=excluded.ingested_at
        WHERE excluded.ts >= records.ts
      `).bind(
        row.d, row.name, row.name_ev, row.status, row.status_code, row.ts, row.v, row.cat_mask,
        row.ag, row.co, row.steps, row.guest, row.kyc, row.tos, row.tos_url, row.tos_q,
        row.btc, row.btc_any, row.btc_conf, row.conf, row.pay_any, row.pay_online, row.pay_instore,
        row.pay_unscoped, row.pay_no, row.ar_mask, row.anw_type, row.ease, row.search, row.raw_json,
        row.source, row.event_id, row.pubkey, row.sig, row.ingested_at,
      ).run();
    }

    await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('version', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(report.version).run();
    await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('source', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(report.source).run();
    await env.DB.prepare(`INSERT INTO meta (k, v) VALUES ('count', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(String(rows.size)).run();
  }

  if (env.KV) {
    await env.KV.put("snap:current", snapshotToJson(snap));
    await env.KV.put("meta", JSON.stringify(snap.meta));
  }

  return snap;
}

export async function ingest(src: RecordSource, env: EnvLike, opts: IngestOptions = {}): Promise<IngestReport> {
  const chunks: RawRecord[] = [];
  for await (const r of src.read()) chunks.push(r);
  const contentHash = hashSource(JSON.stringify(chunks));
  const { rows, report } = await ingestFromLines(
    (async function* () { for (const r of chunks) yield r; })(),
    { ...opts, contentHash, sourceLabel: src.name },
  );
  await persistIngest(rows, report, env);
  return report;
}
