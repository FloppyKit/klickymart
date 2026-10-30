/** Nostr event kinds used by KlickyMart (single source of truth). */
export const NOSTR_KIND_CRAWL_RECORD = 31420;

/** NIP-32 label namespace for crawl-record tags (unassigned NIP placeholder). */
export const NIP_CRAWL_NAMESPACE = "nip-xx";

/** Provisional handshake kinds (NIP-XX draft): need, fulfillment, acceptance. A 422 that references a 31420 record via
 * an `a` tag and carries a `rating` tag is also a merchant review. */
export const NOSTR_KIND_NEED = 420;
export const NOSTR_KIND_FULFILLMENT = 421;
export const NOSTR_KIND_ACCEPTANCE = 422;
