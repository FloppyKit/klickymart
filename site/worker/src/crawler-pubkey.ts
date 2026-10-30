import { bech32 } from "@scure/base";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { RecordRow } from "./normalize";
import type { Snapshot } from "./index-mem";

const HEX64 = /^[0-9a-f]{64}$/i;

export function hexToNpub(hex: string): string {
  if (!HEX64.test(hex)) throw new Error("invalid pubkey hex");
  // NIP-19: bech32("npub", the 32 key bytes). (KM-004: a leading zero byte here produced npubs no client could decode.)
  return bech32.encode("npub", bech32.toWords(hexToBytes(hex.toLowerCase())));
}

export function discoverCrawlerPubkeyHex(rows: RecordRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const pk = row.pubkey?.toLowerCase();
    if (!pk || !HEX64.test(pk)) continue;
    counts.set(pk, (counts.get(pk) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [pk, n] of counts) {
    if (n > bestN) {
      best = pk;
      bestN = n;
    }
  }
  return best;
}

export function crawlerPubkeyHexFromSnapshot(snap: Snapshot, envHex?: string): string | null {
  if (envHex && HEX64.test(envHex)) return envHex.toLowerCase();
  return snap.meta.crawler_pubkey_hex ?? null;
}

export function crawlerNpubFromSnapshot(snap: Snapshot, envHex?: string): string | null {
  const hex = crawlerPubkeyHexFromSnapshot(snap, envHex);
  if (!hex) return null;
  try {
    return hexToNpub(hex);
  } catch {
    return null;
  }
}
