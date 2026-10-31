/** GP-5: one source of truth for special-use / private DNS names (RFC 6761, 6762, 7686, 9476, 8375) and common private TLDs. */
export const SPECIAL_SUFFIXES = [
  "localhost", "local", "localdomain", "internal", "invalid", "test", "example", "onion", "alt", "arpa",
  "home", "lan", "corp", "intranet", "private", "home.arpa",
] as const;
const IPV4ISH = /^(?:0x[0-9a-f]*|[0-9]+)$/;
/** True when h is a special-use or private name, an IP literal (any spelling, v4 or v6), or a single-label host. */
export function isSpecialUseHost(h: string): boolean {
  if (typeof h !== "string") return true;
  const s = h.toLowerCase().replace(/\.$/, "");
  if (!s || s.includes(":") || s.startsWith("[")) return true; // IPv6 literal or garbage
  const labels = s.split(".");
  if (labels.length < 2) return true; // single label
  if (labels.every((l) => IPV4ISH.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return true; // IPv4 literal forms, numeric TLD
  return SPECIAL_SUFFIXES.some((x) => s === x || s.endsWith(`.${x}`));
}
