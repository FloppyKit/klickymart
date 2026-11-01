/** Nostr event kinds used by KlickyMart (single source of truth). */
export const NOSTR_KIND_CRAWL_RECORD = 31420;

/** NIP-32 label namespace for crawl-record tags (unassigned NIP placeholder). */
export const NIP_CRAWL_NAMESPACE = "nip-xx";

/** Provisional handshake kinds (NIP-XX draft): need, fulfillment, acceptance. A 422 that references a 31420 record via
 * an `a` tag and carries a `rating` tag is also a merchant review. */
export const NOSTR_KIND_NEED = 420;
export const NOSTR_KIND_FULFILLMENT = 421;
export const NOSTR_KIND_ACCEPTANCE = 422;

/** Community "store suggestion" (Path 3). 1423 is unassigned in the NIP kind index (checked 2026-10-30); see NIP-DRAFT.md. */
export const NOSTR_KIND_STORE_SUGGESTION = 1423;

/** M2 endpoint binding (v9.2 §2): addressable, one per store key, fixed d tag. PROVISIONAL: v9.2 picks no number (not
 * 30078); 31421 is a placeholder pending the kind-collision check and Satoshi/Matt sign-off. Change here only. */
export const NOSTR_KIND_ENDPOINT_BINDING = 31421;
