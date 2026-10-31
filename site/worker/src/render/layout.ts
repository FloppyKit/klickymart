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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · KlickyMart</title>
<meta name="description" content="A signed map of where agents can shop. Records published as Nostr events.">
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/km.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body class="km-has-landscape${o.path === "/" ? " km-page-home" : ""}${o.sceneOnly ? " km-scene-only" : ""}">
<a class="km-skip" href="#main">Skip to content</a>
<div class="km-landscape-wrap" aria-hidden="true">
  <canvas id="km-landscape" class="km-landscape-canvas" data-reach="${reach}" data-btc="${btc}"${tierAttr}${storyAttr}${visitsAttr}></canvas>
  <canvas id="km-landscape-gl" class="km-landscape-canvas km-landscape-gl" hidden aria-hidden="true"></canvas>
</div>
<header class="km-header" role="banner">
  <a class="km-wordmark" href="/">
    <svg class="km-glyph" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path fill="currentColor" d="M3 3h5v5H3V3zm7 0h5v5h-5V3zM3 10h5v5H3v-5zm7 2h5v3h-5v-3z"/></svg>
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
  ${o.siteTip ? `<p class="km-footer-v4v" data-testid="km-site-tip">Value for value: if KlickyMart helped, tip <a href="lightning:${esc(o.siteTip)}" rel="nofollow">⚡ ${esc(o.siteTip)}</a>. Optional; nothing is unlocked by tipping.</p>` : ""}
  <p class="km-footer-meta">A signed map of where agents can shop. Records published as Nostr events. · Data version ${esc(o.version)} · Crawls ${esc(tsRange)}</p>
</footer>
<script src="/km.js" defer></script>
<script src="/km-landscape.js" defer></script>
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
