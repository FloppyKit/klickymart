/** R7-007: SRI for the site scripts; test/nostr-app.test.ts recomputes these from public/. */
export const KM_JS_SRI = "sha384-S3m0mzA8ypc57LZuVF0IajyqKB2l4YmHtk88vNbD5Sdqpegm+pPzTge4/LOeUpPN";
export const KM_LANDSCAPE_SRI = "sha384-379j43ps8jMXjuJIqiKUODoXVgKyJ1adKX4Kaee0XM+rIJxkI/T0bdlrOz8H3hAZ";
import { shopperSplit } from "../agent-visits";
export function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** KM-006: serialize JSON for an inline <script> data block. JSON.stringify leaves "</script>" and U+2028/2029 intact;
 * escape <, >, & and the line separators as \uXXXX so crawled strings can never close the element. */
export function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** KM-006: strict CSP for every HTML page. No inline script is allowed (pages use only same-origin script files;
 * JSON-LD data blocks are not executed). Inline styles stay allowed for existing style attributes. */
export const HTML_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

export interface LayoutOpts {
  title: string;
  origin: string;
  version: string;
  tsMin: number;
  tsMax: number;
  body: string;
  path: string;
  previewData?: boolean;
  landscapeReach?: number;
  landscapeBtc?: number;
  landscapeTier?: number;
  sceneOnly?: boolean;
  story?: { total: number; reachable: number; private_btc: number; private_btc_reachable: number };
  agentVisitsToday?: number;
  /** Value-for-value Lightning address for the site itself (SITE_TIP_LUD16). Hidden when unset. */
  siteTip?: string | null;
  /** Unique meta/og description for this page (falls back to a per-path default). */
  description?: string;
  /** Extra JSON-LD objects for this page (rendered as non-executed data blocks). */
  jsonLd?: unknown[];
}
const SITE_DESC = "KlickyMart: a signed, open (CC0) map of which online stores AI shopping agents can actually buy from: guest checkout, payment methods, agent rules and landed cost. Records are published as Nostr events.";
const PATH_DESC: Record<string, string> = {
  "/": SITE_DESC,
  "/about": "About KlickyMart: how KlickyBot crawls stores (robots.txt first, terms honored, never buys), how records are signed as Nostr events, and how the data is licensed (CC0).",
  "/dashboard": "Filter KlickyMart's store index by payment method, Bitcoin grade, guest checkout and agent reachability.",
  "/docs/api": "KlickyMart API: /q, /check, /landed, /offers, /alternatives and the MCP server for AI shopping agents. No key needed.",
  "/docs/nostr-tags": "The Nostr tags KlickyMart uses on kind 31420 store records and shopping-experience notes.",
  "/docs/relay-filters": "Relay filters to read KlickyMart store records and shopping notes straight from Nostr relays.",
  "/app": "KlickyMart feeds: follow store records and agents' shopping-experience notes from Nostr relays.",
  "/contribute": "Contribute to KlickyMart: suggest a store, post a signed shopping-experience note, or correct a record.",
  "/check": "Can my agent shop here? KlickyMart's verdict for one store: reachable, checkout-blocked, agents-not-welcome or blocked by terms.",
  "/alternatives": "Stores an AI agent can actually check out at, as alternatives to one that blocks agents.",
  "/chart": "KlickyMart's store chart: stores ranked by crawl facts and signed shopping notes from agents that visited.",
  "/report": "Write and sign a shopping-experience note (kind 422) about a store, in your browser. Nothing is sent without your confirmation.",
  "/wallet": "Non-custodial wallet setup for agents that pay with Lightning: KlickyMart never holds keys or funds.",
  "/claim": "Store owners: prove you run a domain and publish your own signed KlickyMart record.",
  "/q": "KlickyMart query results: stores matching your payment, checkout and agent-access filters.",
};
export function siteJsonLd(origin: string): unknown[] {
  return [
    { "@context": "https://schema.org", "@type": "WebSite", name: "KlickyMart", url: `${origin}/`, potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${origin}/q?q={search_term_string}` }, "query-input": "required name=search_term_string" } },
    { "@context": "https://schema.org", "@type": "Organization", name: "KlickyMart", alternateName: "FloppyKit KlickyMart", url: `${origin}/`, logo: `${origin}/logo-512.png`, sameAs: ["https://github.com/FloppyKit/klickymart"], email: "bot@klickymart.com" },
  ];
}
export function datasetJsonLd(origin: string): unknown {
  return { "@context": "https://schema.org", "@type": "Dataset", name: "KlickyMart store records", description: "Signed records (Nostr kind 31420) of how AI shopping agents can buy from online stores: robots and terms, guest checkout, payment methods, Bitcoin acceptance, shipping and tax facts.",
    url: `${origin}/`, license: "https://creativecommons.org/publicdomain/zero/1.0/", isAccessibleForFree: true, creator: { "@type": "Organization", name: "KlickyMart", url: `${origin}/` },
    distribution: [
      { "@type": "DataDownload", encodingFormat: "application/x-ndjson", contentUrl: `${origin}/export.ndjson` },
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${origin}/q` },
    ] };
}

export function layout(o: LayoutOpts): string {
  const tsRange = o.tsMin && o.tsMax
    ? `${new Date(o.tsMin * 1000).toISOString().slice(0, 10)} – ${new Date(o.tsMax * 1000).toISOString().slice(0, 10)}`
    : "—";
  const reach = typeof o.landscapeReach === "number" ? o.landscapeReach.toFixed(4) : "0";
  const btc = typeof o.landscapeBtc === "number" ? o.landscapeBtc.toFixed(4) : "0";
  const tierAttr = typeof o.landscapeTier === "number" ? ` data-tier="${o.landscapeTier}"` : "";
  const storyAttr = o.story
    ? ` data-total="${o.story.total}" data-reachable="${o.story.reachable}" data-private-btc="${o.story.private_btc}" data-private-btc-reachable="${o.story.private_btc_reachable}"`
    : "";
  const visitsAttr = typeof o.agentVisitsToday === "number"
    ? (() => { const s = shopperSplit(o.agentVisitsToday); return ` data-agent-visits="${o.agentVisitsToday}" data-shoppers-real="${s.real}" data-shoppers-simulated="${s.simulated}"`; })()
    : "";
  const previewBadge = o.previewData
    ? `<span class="km-preview-badge" role="status">Preview data</span>`
    : "";
  const desc = o.description ?? PATH_DESC[o.path] ?? (o.path.startsWith("/docs") ? PATH_DESC["/docs/api"]! : SITE_DESC);
  const canon = `${o.origin}${o.path || "/"}`;
  const ld = [...(o.path === "/" || o.path === "/about" ? siteJsonLd(o.origin) : []), ...(o.path === "/" ? [datasetJsonLd(o.origin)] : []), ...(o.jsonLd ?? [])];
  const ldHtml = ld.map((x) => `<script type="application/ld+json">${jsonForScript(x)}</script>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · KlickyMart</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canon)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="KlickyMart">
<meta property="og:title" content="${esc(o.title)} · KlickyMart">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canon)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(o.title)} · KlickyMart">
<meta name="twitter:description" content="${esc(desc)}">
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/km.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:image" content="${esc(o.origin)}/logo-512.png">
${ldHtml}
</head>
<body class="km-has-landscape${o.path === "/" ? " km-page-home" : ""}${o.sceneOnly ? " km-scene-only" : ""}">
<a class="km-skip" href="#main">Skip to content</a>
<div class="km-landscape-wrap" aria-hidden="true">
  <canvas id="km-landscape" class="km-landscape-canvas" data-reach="${reach}" data-btc="${btc}"${tierAttr}${storyAttr}${visitsAttr}></canvas>
  <canvas id="km-landscape-gl" class="km-landscape-canvas km-landscape-gl" hidden aria-hidden="true"></canvas>
</div>
<header class="km-header" role="banner">
  <a class="km-wordmark" href="/">
    <img class="km-glyph" src="/icon-192.png" width="24" height="24" alt="KlickyMart">
    KlickyMart
  </a>
  ${previewBadge}
  <nav class="km-nav" aria-label="Primary">
    <a href="/"${o.path === "/" ? ' aria-current="page"' : ""}>Search</a>
    <a href="/dashboard"${o.path.startsWith("/dashboard") ? ' aria-current="page"' : ""}>Dashboard</a>
    <a href="/docs/api"${o.path.startsWith("/docs") ? ' aria-current="page"' : ""}>API</a>
    <a href="/app"${o.path === "/app" ? ' aria-current="page"' : ""}>Feeds</a>
    <a href="/contribute"${o.path === "/contribute" ? ' aria-current="page"' : ""}>Contribute</a>
    <a href="/about"${o.path === "/about" ? ' aria-current="page"' : ""}>About</a>
    <button type="button" class="km-theme-toggle" id="km-theme-toggle" aria-label="Toggle color theme">Theme</button>
  </nav>
</header>
<main id="main" class="km-main" role="main">
${o.body}
</main>
<footer class="km-footer" role="contentinfo">
  <p class="km-footer-signoff">Thank You, Come Again.</p>
  <p class="km-footer-tag">KlickyMart by FloppyKit. Records published as Nostr events (kind 31420). Code and data: <a href="https://github.com/FloppyKit/klickymart">GitHub</a>. Crawler: <a href="/bot">/bot</a>. Contact: <a href="mailto:bot@klickymart.com">bot@klickymart.com</a></p>
  ${o.siteTip ? `<p class="km-footer-v4v" data-testid="km-site-tip">Value for value: if KlickyMart helped, tip <a href="lightning:${esc(o.siteTip)}" rel="nofollow">⚡ ${esc(o.siteTip)}</a>. Optional; nothing is unlocked by tipping. No ads, no paid rankings; tips help cover hosting.</p>` : ""}
  <p class="km-footer-meta">A signed map of where agents can shop. Records published as Nostr events. · Data version ${esc(o.version)} · Crawls ${esc(tsRange)}</p>
</footer>
<script src="/km.js" integrity="${KM_JS_SRI}" crossorigin="anonymous" defer></script>
<script src="/km-landscape.js" integrity="${KM_LANDSCAPE_SRI}" crossorigin="anonymous" defer></script>
</body>
</html>`;
}

export function eyebrow(text: string): string {
  return `<p class="km-eyebrow">${esc(text)}</p>`;
}

export function gradeBadge(btc: number | null): string {
  if (btc === null) return `<span class="km-grade km-g-ungraded" title="Bitcoin not graded">BTC –</span>`;
  const priv = btc >= 3 ? " km-g-private" : "";
  const title = btc >= 3 ? `Private Bitcoin, grade ${btc} of 4` : `Bitcoin grade ${btc} of 4`;
  return `<span class="km-grade km-g${btc}${priv}" title="${title}">BTC ${btc}/4</span>`;
}

export function statusPill(status: string): string {
  const map: Record<string, string> = {
    crawled: "Reachable",
    "blocked-tos": "ToS bans automation",
    "agents-not-welcome": "Agents not welcome",
    error: "Error",
  };
  const cls = status === "crawled" ? "ok" : status === "blocked-tos" ? "tos" : status === "agents-not-welcome" ? "anw" : "err";
  return `<span class="km-status km-status-${cls}">${esc(map[status] ?? status)}</span>`;
}

/** Striped shop awning used as a section header below the fold. */
export function awning(title: string, sub?: string, tag: "h1" | "h2" = "h2"): string {
  return `<div class="km-awning"><div class="km-awning-stripes" aria-hidden="true"></div><${tag} class="km-awning-title">${esc(title)}</${tag}>${sub ? `<p class="km-awning-sub">${esc(sub)}</p>` : ""}</div>`;
}
