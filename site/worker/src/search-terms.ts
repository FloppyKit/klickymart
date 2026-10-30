/** Query tokenization + product synonyms shared by /offers and /q (search_merchants). */
const STOP = new Set(["the", "for", "with", "and", "under", "over", "a", "an", "of", "to", "in", "on", "buy", "cheap", "best", "new", "shipped"]);
// Multi-word phrases collapsed to one concept token before splitting.
const PHRASES: [RegExp, string][] = [
  [/\b(active\s+)?noise[\s-]*(cancel+(ing|ation|led)?|reduc(ing|tion))\b|\banc\b|\bnc\b/g, " anc "],
  [/\bover[\s-]*(the[\s-]*)?ear\b|\baround[\s-]*ear\b|\bcircum[\s-]*aural\b/g, " overear "],
  [/\bon[\s-]*ear\b/g, " onear "],
  [/\bin[\s-]*ear\b|\bear[\s-]*buds?\b/g, " earbuds "],
  [/\bhead[\s-]*phones?\b|\bheadsets?\b/g, " headphones "],
  [/\bgift[\s-]*cards?\b|\be[\s-]*gift\b/g, " giftcard "],
];
const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

function base(s: string): string {
  let t = s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  for (const [rx, c] of PHRASES) t = t.replace(rx, c);
  return t;
}
export function queryTokens(q: string): string[] {
  return base(q).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}
/** Tokens for an offer: its words plus concept tokens implied by known product lines (e.g. QuietComfort = ANC over-ear). */
export function offerTokens(name: string, brand?: string | null): Set<string> {
  const raw = `${brand ?? ""} ${name}`;
  const set = new Set(queryTokens(raw));
  const l = raw.toLowerCase();
  if (/quietcomfort|\bqc ?(35|45|ultra)\b|wh-?1000x|airpods max|bose (nc|noise)|momentum 4|sonos ace/.test(l)) set.add("anc");
  if (set.has("headphone") && !/earbud|in-ear|true wireless/.test(l)) set.add("overear");
  if (set.has("headphone") && /quietcomfort|ace|wh-?1000|airpods max|momentum/.test(l)) set.add("overear");
  return set;
}
/** How many query tokens an offer covers. */
export function coverage(qt: string[], ot: Set<string>): number { return qt.filter((w) => ot.has(w)).length; }
