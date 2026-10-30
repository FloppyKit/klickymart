import { LICENSE_DATA, LICENSE_DATA_URL, LICENSE_CODE, LICENSE_CODE_URL } from "./license-meta";
import { NOSTR_KIND_CRAWL_RECORD } from "./nostr-kinds";
import type { Snapshot } from "./index-mem";
import { crawlerNpubFromSnapshot, crawlerPubkeyHexFromSnapshot } from "./crawler-pubkey";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

export function parseRelayUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...DEFAULT_RELAYS];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) return arr.filter((u): u is string => typeof u === "string" && u.length > 0);
    } catch {
      /* fall through */
    }
  }
  return trimmed.split(/[\s,]+/).filter(Boolean);
}

export function buildKlickymartWellKnown(
  origin: string,
  snap: Snapshot,
  opts: { contact: string; relayUrlsRaw?: string; crawlerPubkeyHexEnv?: string },
): Record<string, unknown> {
  const npub = crawlerNpubFromSnapshot(snap, opts.crawlerPubkeyHexEnv);

  return {
    name: "KlickyMart",
    description: "Signed map of where software agents can shop (Nostr kind 31420 crawl records).",
    site: origin,
    record_schema_version: "0.3-draft",
    nostr_kinds: {
      crawl_record: NOSTR_KIND_CRAWL_RECORD,
    },
    endpoints: {
      query: `${origin}/q`,
      query_html: `${origin}/q`,
      summary: `${origin}/summary.json`,
      stats: `${origin}/stats`,
      export_ndjson: `${origin}/export.ndjson`,
      record: `${origin}/records/{domain}`,
      openapi: `${origin}/openapi.json`,
      mcp: `${origin}/mcp`,
      well_known: `${origin}/.well-known/klickymart.json`,
      nostr_nip05: `${origin}/.well-known/nostr.json`,
    },
    example_queries: [
      `${origin}/q?btc=2&guest=1&pay=lightning`,
      `${origin}/q?reachable=1&btc_min=3`,
      `${origin}/q?category=shopping&pay_group=bitcoin`,
    ],
    relays: parseRelayUrls(opts.relayUrlsRaw),
    crawler: { npub },
    license: {
      software: { spdx: LICENSE_CODE, url: LICENSE_CODE_URL },
      data: { spdx: LICENSE_DATA, url: LICENSE_DATA_URL, file: `${origin}/DATA-LICENSE` },
    },
    contact: opts.contact,
    snapshot_version: snap.version,
  };
}

export function buildNostrWellKnown(
  snap: Snapshot,
  crawlerPubkeyHexEnv?: string,
): { names: Record<string, string> } {
  const hex = crawlerPubkeyHexFromSnapshot(snap, crawlerPubkeyHexEnv);
  if (!hex) return { names: {} };
  return { names: { bot: hex } };
}
