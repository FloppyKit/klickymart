import type { RawRecord } from "./normalize";
import type { RecordSource } from "./ingest";
import { NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";

export interface NostrEventLine {
  id?: string;
  pubkey?: string;
  sig?: string;
  kind?: number;
  created_at?: number;
  tags?: string[][];
  content?: string;
}

export type RawRecordWithNostr = RawRecord & {
  event_id?: string;
  pubkey?: string;
  sig?: string;
};

function tagValue(tags: string[][] | undefined, name: string): string | null {
  if (!tags) return null;
  for (const t of tags) {
    if (t[0] === name && typeof t[1] === "string") return t[1];
  }
  return null;
}

/** Parse one NDJSON line into a crawl record (plain JSON or kind 31420 event). */
export function parseRecordLine(line: string): RawRecordWithNostr | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as NostrEventLine | RawRecord;

  if (typeof (parsed as NostrEventLine).kind === "number") {
    const ev = parsed as NostrEventLine;
    if (ev.kind !== NOSTR_KIND_CRAWL_RECORD) {
      throw new Error(`unsupported kind ${ev.kind}; expected ${NOSTR_KIND_CRAWL_RECORD}`);
    }
    if (typeof ev.content !== "string" || !ev.content.trim()) {
      throw new Error("kind 31420 event missing content");
    }
    const record = JSON.parse(ev.content) as RawRecord;
    const dTag = tagValue(ev.tags, "d");
    if (dTag && typeof record.d === "string" && record.d.toLowerCase() !== dTag.toLowerCase()) {
      throw new Error("d tag disagrees with content.d");
    }
    if (!record.d && dTag) record.d = dTag;
    return {
      ...record,
      event_id: typeof ev.id === "string" ? ev.id : undefined,
      pubkey: typeof ev.pubkey === "string" ? ev.pubkey : undefined,
      sig: typeof ev.sig === "string" ? ev.sig : undefined,
    };
  }

  return parsed as RawRecordWithNostr;
}

/** Ingest signed kind 31420 events (or plain records) from NDJSON text. */
export class Nostr31420NdjsonSource implements RecordSource {
  name = "nostr-31420-ndjson";

  constructor(private text: string) {}

  async *read(): AsyncIterable<RawRecord> {
    let lineNum = 0;
    for (const line of this.text.split("\n")) {
      lineNum++;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = parseRecordLine(trimmed);
        if (rec) yield rec;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`line ${lineNum}: ${msg}`);
      }
    }
  }
}
