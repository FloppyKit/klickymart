import type { Community } from "../community";
import type { ReviewSummary } from "../reviews";
import { MCP_SNIPPETS, REVIEW_GUIDE } from "../llms";
import { SIMULATED_SHOPPER_FLOOR, VISITS_PER_SHOPPER } from "../agent-visits";
import type { IndexRow, Snapshot } from "../index-mem";
import { renderAgentPolicy, renderCheckoutDetail, renderV5, renderWhy } from "../explain";
import { awning, esc, eyebrow, gradeBadge, layout, statusPill } from "./layout";
import type { PageShell } from "./page-shell";
import { computeStats, merchantUrl, parseRaw, payLabel, rowToCompact, uniquePayLabels } from "../records-api";
import { computeStoryCounts, landscapeFormulaInputs, storyLine } from "../landscape-metrics";
import { NOSTR_KIND_CRAWL_RECORD, NIP_CRAWL_NAMESPACE } from "../nostr-kinds";

const ANW_LABELS: Record<string, string> = {
  "block-page": "Block page shown to the crawler",
  "http-403": "HTTP 403 Forbidden",
  "http-429": "HTTP 429 Too Many Requests",
  "http-503": "HTTP 503 Service Unavailable",
  "robots-403": "robots.txt returned 403",
  "robots-429": "robots.txt returned 429",
  "robots-block-page": "robots.txt points to a block page",
  "robots-disallow": "robots.txt disallows the crawler",
  "home-unreachable": "Home page could not be fetched",
  "robots-unreachable": "robots.txt could not be fetched",
};

function anwReasonText(raw: Record<string, unknown>): string {
  const anw = raw.anw;
  if (!anw || typeof anw !== "object") return "Agents not welcome (reason not recorded)";
  const type = typeof (anw as { type?: unknown }).type === "string" ? (anw as { type: string }).type : "";
  const q = typeof (anw as { q?: unknown }).q === "string" ? (anw as { q: string }).q : "";
  const label = ANW_LABELS[type] ?? type.replace(/-/g, " ");
  return q ? `${label}: ${q}` : label;
}

function pageLayout(
  base: Parameters<typeof layout>[0],
  shell: PageShell,
): string {
  return layout({
    ...base,
    previewData: shell.previewData,
    landscapeReach: shell.landscapeReach,
    landscapeBtc: shell.landscapeBtc,
    landscapeTier: shell.landscapeTier,
    sceneOnly: shell.sceneOnly,
    story: shell.story,
    agentVisitsToday: shell.agentVisitsToday,
  });
}

export function renderHome(snap: Snapshot, origin: string, q: string | null, items: IndexRow[], shell: PageShell): string {
  const quick = [
    { href: "/dashboard?pay_group=lightning&scope=any", label: "Takes Lightning" },
    { href: "/dashboard?btc_min=3", label: "BTC grade 3+" },
    { href: "/dashboard?reachable=1", label: "Reachable by agents" },
    { href: "/dashboard?guest=1", label: "Guest checkout" },
  ];
  const story = computeStoryCounts(snap.rows);
  const rows = items.slice(0, 20).map((row) => {
    const c = rowToCompact(row, origin);
    const pays = uniquePayLabels([...c.pay.online, ...c.pay.instore, ...c.pay.unscoped]).slice(0, 4)
      .map((l) => `<span class="km-pay-chip">${esc(l)}</span>`).join("");
    return `<li class="km-result-row km-tag">
      <div class="km-tag-id"><a href="${esc(merchantUrl(origin, row.d))}"><strong>${esc(row.name ?? row.d)}</strong></a>
      <span class="km-tag-domain">${esc(row.d)}</span></div>
      <div class="km-tag-labels">${statusPill(row.status)}${gradeBadge(row.btc)}</div>
      <div class="km-pay-list">${pays || "<span class=\"km-muted\">pay unknown</span>"}</div>
    </li>`;
  }).join("");

  const body = `
<div class="km-home-scene-gap" aria-hidden="true"></div>
<section class="km-hero km-hero-panel km-home-hero">
  ${eyebrow("OPEN DATA · SIGNED RECORDS · NO LOGIN")}
  <h1>Where agents shop.</h1>
  <p class="km-story" data-testid="story-line">${esc(storyLine(story))}</p>
  <p class="km-story-key">The road fills in as stores open to agents; the sun rises as private Bitcoin spreads.</p>
  <form class="km-search" method="get" action="/">
    <label class="km-sr-only" for="q">Search</label>
    <input id="q" name="q" value="${esc(q ?? "")}" placeholder="Search merchants or domains">
    <button type="submit">Search</button>
  </form>
  <form class="km-search km-check" method="get" action="/check" data-testid="check-form">
    <label for="check-domain">Can my agent shop here?</label>
    <input id="check-domain" name="domain" placeholder="example.com" autocomplete="off" required>
    <input type="hidden" name="format" value="html">
    <button type="submit">Check</button>
  </form>
  <output id="check-result" class="km-check-result" data-testid="check-result" aria-live="polite"></output>
  <form class="km-search km-check" method="get" action="/alternatives" data-testid="alt-form">
    <label for="alt-q">Where else can my agent buy this?</label>
    <input id="alt-q" name="category" placeholder="headphones, gift card, groceries…" autocomplete="off" required>
    <select name="pay" aria-label="Pays with"><option value="">any payment</option><option value="lightning">Lightning</option><option value="btc">Bitcoin</option><option value="cashu">Cashu</option></select>
    <label class="km-inline"><input type="checkbox" name="guest" value="1"> no account</label>
    <input type="hidden" name="format" value="html">
    <button type="submit">Find</button>
  </form>
</section>
<div class="km-store">
${awning("On the shelves", "Which stores a software agent can reach, how checkout works, and every way they let you pay. Bitcoin graded 0–4 for privacy; every record links to the page it came from.")}
<section class="km-section km-home-quick">
  <h2 class="km-sr-only">Start with</h2>
  <ul class="km-quick">${quick.map((l) => `<li><a class="km-btn km-btn-ghost" href="${esc(l.href)}">${esc(l.label)}</a></li>`).join("")}</ul>
</section>
<section class="km-section km-home-list" aria-label="Stores">
  <div class="km-tag-legend km-muted"><span>Agent access</span><span>BTC privacy grade 0–4 <span class="km-legend-priv">3+ = private</span></span></div>
  <ul class="km-results">${rows || `<li class="km-empty">No sites match. Try fewer filters.</li>`}</ul>
</section>
<section class="km-section km-agents km-staff">
  <p class="km-staff-label">STAFF ONLY · FOR AGENTS</p>
  <h2 class="km-h2">For agents</h2>
  <p>Query the map over HTTP, MCP, or a plain NDJSON file. No key needed.</p>
  <div class="km-codeblock"><span class="km-code-label">HTTP</span><pre><code>curl '${origin}/q?reachable=1&amp;limit=5'</code></pre></div>
  <div class="km-codeblock"><span class="km-code-label">MCP</span><pre><code>${origin}/mcp</code></pre></div>
  <div class="km-codeblock"><span class="km-code-label">NDJSON</span><pre><code>curl '${origin}/export.ndjson'</code></pre></div>
  <p class="km-receipt-foot">NO KEY · NO LOGIN · CC0 DATA</p>
</section>
</div>`;

  return pageLayout({
    title: "Where agents shop",
    origin,
    version: snap.version,
    tsMin: snap.meta.ts_min,
    tsMax: snap.meta.ts_max,
    body,
    path: "/",
  }, shell);
}

export function renderDashboard(snap: Snapshot, origin: string, searchParams: URLSearchParams, items: IndexRow[], total: number, shell: PageShell): string {
  const stats = computeStats(snap.rows) as {
    by_status: Record<string, number>;
    btc_histogram: Record<string, number>;
    ag_distribution: Record<string, number>;
    pay_counts: Record<string, { online: number; instore: number; unscoped: number }>;
    bitcoin_accepting: { d: string; name: string | null; btc: number | null }[];
    records: number;
  };
  const landscapeIn = landscapeFormulaInputs(snap.rows);
  const reachable = snap.rows.filter((r) => r.status === "crawled" && r.ag !== null && r.ag >= 1).length;
  const tiles = [
    { label: "Crawled", count: stats.by_status.crawled ?? 0, href: "/dashboard?status=crawled" },
    { label: "Reachable (ag≥1)", count: reachable, href: "/dashboard?reachable=1" },
    { label: "ToS bans automation", count: stats.by_status["blocked-tos"] ?? 0, href: "/dashboard?status=blocked-tos" },
    { label: "Agents not welcome", count: stats.by_status["agents-not-welcome"] ?? 0, href: "/dashboard?status=agents-not-welcome" },
    { label: "Errors", count: stats.by_status.error ?? 0, href: "/dashboard?status=error" },
    { label: "Total", count: stats.records, href: "/dashboard" },
  ];

  const hist = stats.btc_histogram ?? {};
  const histKeys = ["0", "1", "2", "3", "4", "ungraded"];
  const maxH = Math.max(1, ...histKeys.map((k) => hist[k] ?? 0));
  const bars = histKeys.map((k, i) => {
    const v = hist[k] ?? 0;
    const h = Math.round((v / maxH) * 100);
    const label = k === "ungraded" ? "∅" : k;
    const x = i * 40 + 5;
    return `<g><rect class="km-bar" x="${x}" y="${100 - h}" width="32" height="${h}"/><text x="${x + 16}" y="115">${label}</text><title>${k === "ungraded" ? "not graded" : `grade ${k}`}: ${v}</title></g>`;
  }).join("");

  const agDist = stats.ag_distribution ?? {};
  const agRows = ["0", "1", "2", "3", "unknown"].map((k) =>
    `<tr><td>ag ${k === "unknown" ? "unknown" : k}</td><td>${agDist[k] ?? 0}</td></tr>`,
  ).join("");

  const payCounts = stats.pay_counts ?? {};
  const payRows = Object.entries(payCounts)
    .sort((a, b) => (b[1].online + b[1].instore + b[1].unscoped) - (a[1].online + a[1].instore + a[1].unscoped))
    .slice(0, 20)
    .map(([code, c]) => `<tr><td>${esc(payLabel(code))}</td><td>${c.online}</td><td>${c.instore}</td><td>${c.unscoped}</td></tr>`)
    .join("");

  const btcList = (stats.bitcoin_accepting ?? [])
    .slice(0, 40)
    .map((m) => `<li><a href="${esc(merchantUrl(origin, m.d))}">${esc(m.name ?? m.d)}</a> <span class="km-muted">${esc(m.d)}</span> ${gradeBadge(m.btc)}</li>`)
    .join("");

  const tableRows = items.slice(0, 100).map((row) => renderTableRow(row, origin)).join("");

  const categoryVal = searchParams.get("category") ?? "";
  const statusVal = searchParams.get("status") ?? "";
  const statusOptions = ["crawled", "agents-not-welcome", "blocked-tos", "error"].map((s) =>
    `<option value="${s}"${statusVal === s ? " selected" : ""}>${s}</option>`,
  ).join("");

  const body = `
<div class="km-store km-dash">
${awning("The map, in numbers.", "Every site we checked, what stopped us, and what they accept. The landscape inputs below drive the road, the store and the sun.", "h1")}
<div class="km-tiles">${tiles.map((t) => `<a class="km-tile" href="${esc(t.href)}"><span class="km-tile-n">${t.count}</span><span class="km-tile-l">${esc(t.label)}</span></a>`).join("")}</div>

<section class="km-section km-receipt">
<h2 class="km-h2">Landscape inputs</h2>
<dl class="km-dl">
<dt>Reach (${landscapeIn.reach.value.toFixed(4)})</dt>
<dd>${landscapeIn.reach.reachable_merchants} reachable of ${landscapeIn.reach.total_merchants} merchants · <code>${esc(landscapeIn.reach.formula)}</code></dd>
<dt>BTC sun (${landscapeIn.btc_sun.value.toFixed(4)})</dt>
<dd>${landscapeIn.btc_sun.candidate_merchants} BTC-accepting merchants · mean privacy score ${landscapeIn.btc_sun.mean_privacy_score.toFixed(4)} · <code>${esc(landscapeIn.btc_sun.formula)}</code>
<ul>${landscapeIn.btc_sun.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></dd>
</dl>
</section>

<div class="km-receipt-grid">
<section class="km-receipt">
<h2 class="km-h2">Bitcoin grade (all sites)</h2>
<p class="km-muted">Ungraded (<span class="km-grade km-g-ungraded">not graded</span>) is distinct from grade 0.</p>
<svg class="km-chart" viewBox="0 0 260 120" role="img" aria-label="Bitcoin grade histogram">${bars}</svg>
</section>
<section class="km-receipt">

<h2 class="km-h2">Agent access (ag)</h2>
<table class="km-table km-table-compact"><thead><tr><th>ag</th><th>Sites</th></tr></thead><tbody>${agRows}</tbody></table>
</section>
</div>
<section class="km-receipt">

<h2 class="km-h2">Payment methods (observed)</h2>
<table class="km-table km-table-compact"><thead><tr><th>Method</th><th>Online</th><th>In-store</th><th>Unscoped</th></tr></thead><tbody>${payRows || `<tr><td colspan="4">—</td></tr>`}</tbody></table>
</section>
<section class="km-receipt">

<h2 class="km-h2">Bitcoin-accepting merchants</h2>
<ul class="km-btc-list">${btcList || `<li class="km-muted">None indexed</li>`}</ul>
${(stats.bitcoin_accepting?.length ?? 0) > 40 ? `<p class="km-muted">Showing 40 of ${stats.bitcoin_accepting!.length}. Use <code>/q?pay_group=bitcoin</code> for the full set.</p>` : ""}
</section>

<form class="km-filters" method="get" action="/dashboard">
  <details open><summary>Filters</summary>
  <label for="category-filter">Category</label>
  <select id="category-filter" name="category" aria-label="Filter by category">
    <option value="">Any</option>
    <option value="shopping"${categoryVal === "shopping" ? " selected" : ""}>Shopping (v1)</option>
  </select>
  <label for="status-filter">Status</label>
  <select id="status-filter" name="status" aria-label="Filter by status">
    <option value="">Any</option>${statusOptions}
  </select>
  <button type="submit" class="km-btn km-btn-ghost">Apply</button>
  </details>
</form>
<div class="km-receipt km-receipt-table">
<table class="km-table">
<caption>Merchant map (${total} sites)</caption>
<thead><tr>
<th scope="col">Merchant</th><th scope="col">Status</th><th scope="col">Agent access</th><th scope="col">BTC grade</th>
</tr></thead>
<tbody>${tableRows}</tbody>
</table>
</div>
${total > 100 ? `<p><a href="/dashboard?${esc(searchParams.toString())}&amp;limit=500">Show all</a></p>` : ""}
</div>`;

  return pageLayout({ title: "Dashboard", origin, version: snap.version, tsMin: snap.meta.ts_min, tsMax: snap.meta.ts_max, body, path: "/dashboard" }, shell);
}

function renderTableRow(row: IndexRow, origin: string): string {
  const raw = parseRaw(row.raw_json);
  const name_ev = typeof raw.name_ev === "string" ? raw.name_ev : null;
  const merchantLink = `<a href="${esc(merchantUrl(origin, row.d))}">${esc(row.name ?? row.d)}</a>`;
  const nameLink = name_ev
    ? ` · <a href="${esc(name_ev)}" rel="nofollow noopener" title="Evidence for name">↗</a>`
    : "";
  return `<tr>
    <td>${merchantLink}${nameLink}<br><span class="km-muted">${esc(row.d)}</span></td>
    <td>${statusPill(row.status)}</td>
    <td>${row.ag ?? `<a href="/about#unknowns">unknown</a>`}</td>
    <td>${gradeBadge(row.btc)}</td>
  </tr>`;
}

export function renderMerchant(row: IndexRow, origin: string, shell: PageShell, reviews?: ReviewSummary, aTag?: string | null, community?: Community): string {
  const raw = parseRaw(row.raw_json);
  const reviewsBlock = renderCommunitySection(community) + renderReviewsSection(row.d, reviews, aTag ?? null);
  const issueTitle = encodeURIComponent(`Correction: ${row.d}`);
  const issueBody = encodeURIComponent(`Domain: ${row.d}\n\nDescribe the correction with evidence URL:\n`);

  if (row.status === "blocked-tos") {
    const quote = typeof raw.tos_q === "string" ? raw.tos_q : "";
    const src = typeof raw.tos_url === "string" ? raw.tos_url : null;
    const body = `
<h1>${esc(row.name ?? row.d)}</h1>
<p><a href="https://${esc(row.d)}/" rel="nofollow noopener">${esc(row.d)}</a> ${statusPill(row.status)}</p>
${quote ? `<blockquote class="km-quote">${esc(quote)}</blockquote>` : ""}
${src ? `<p><a href="${esc(src)}" rel="nofollow noopener">Source</a></p>` : ""}
<p class="km-muted">Terms ban automation — no checkout crawl was attempted.</p>
${renderWhy(raw)}
<p><a href="https://github.com/FloppyKit/klickymart/issues/new?title=${issueTitle}&amp;body=${issueBody}">Report correction</a></p>
${reviewsBlock}`;
    return pageLayout({ title: row.name ?? row.d, origin, version: "—", tsMin: row.ts, tsMax: row.ts, body, path: `/merchant/${row.d}` }, shell);
  }

  const anwBlock = row.status === "agents-not-welcome" || row.status === "error"
    ? `<section id="anw"><h2>Why agents were turned away</h2><p>${esc(anwReasonText(raw))}</p>${
      raw.anw && typeof raw.anw === "object" && typeof (raw.anw as { url?: unknown }).url === "string"
        ? `<p><a href="${esc(String((raw.anw as { url: string }).url))}" rel="nofollow noopener">Source</a></p>`
        : ""
    }</section>`
    : "";

  const body = `
<h1>${esc(row.name ?? row.d)}</h1>
<p><a href="https://${esc(row.d)}/" rel="nofollow noopener">${esc(row.d)}</a> ${statusPill(row.status)} ${gradeBadge(row.btc)}</p>
${anwBlock}
${renderWhy(raw)}
${renderAgentPolicy(raw)}
<section id="access"><h2>Can an agent get in?</h2><p>Agent access: ${row.ag ?? "unknown"}</p></section>
<section id="terms"><h2>Their terms</h2><p>${esc(String(row.tos ?? "unknown"))}</p>${typeof raw.tos_url === "string" ? `<blockquote class="km-quote">${esc(String(raw.tos_q ?? ""))}</blockquote><p><a href="${esc(String(raw.tos_url))}" rel="nofollow noopener">Source</a></p>` : ""}</section>
<section id="pay"><h2>How you can pay</h2>${renderPayTable(raw)}</section>
${renderCheckoutDetail(row, raw)}
${renderV5(raw)}
<section id="crawl"><h2>About this record</h2><p>Crawled ${new Date(row.ts * 1000).toISOString()}</p>
<details><summary>Raw record</summary><pre class="km-raw">${esc(JSON.stringify(raw, null, 2))}</pre></details></section>
${reviewsBlock}
<div class="km-callout"><p>Run this store? You can confirm your identity and publish your own record. <a href="/claim?domain=${esc(row.d)}">Claim this domain</a></p></div>
<p><a href="https://github.com/FloppyKit/klickymart/issues/new?title=${issueTitle}&amp;body=${issueBody}">Report correction</a></p>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: row.name ?? row.d, url: `https://${row.d}/` })}</script>`;

  return pageLayout({ title: row.name ?? row.d, origin, version: "—", tsMin: row.ts, tsMax: row.ts, body, path: `/merchant/${row.d}` }, shell);
}

function renderPayTable(raw: Record<string, unknown>): string {
  const pay_q = Array.isArray(raw.pay_q) ? raw.pay_q : [];
  if (!pay_q.length) return `<p><a href="/about#unknowns">unknown</a></p>`;
  const rows = pay_q.map((item, i) => {
    const o = item as { c?: string; url?: string; q?: string; conf?: string; scope?: string };
    const method = o.c ? payLabel(o.c) : "—";
    const url = o.url && o.url !== "#" ? o.url : "";
    return `<tr id="pay-${i}"><td>${esc(method)}</td><td>${esc(o.scope ?? "—")}</td><td>${esc(o.conf ?? "")}</td><td class="km-quote-cell">${esc(o.q ?? "")}</td><td>${url ? `<a href="${esc(url)}" rel="nofollow noopener">Source</a>` : "—"}</td></tr>`;
  }).join("");
  return `<table class="km-table"><thead><tr><th>Method</th><th>Scope</th><th>Confidence</th><th>Quote</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function render404(origin: string, shell: PageShell): string {
  const body = `<h1>Nothing here. Search the map instead.</h1>
<form class="km-search" method="get" action="/"><input name="q" placeholder="Search"><button type="submit">Search</button></form>`;
  return pageLayout({ title: "Not found", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "" }, shell);
}

export function renderAbout(origin: string, snap: Snapshot, shell: PageShell): string {
  const body = `
<h1>How this map is made.</h1>
<p class="km-lead">One crawler, public pages only, honest user agent, and a quote for every claim.</p>
<section id="landscape"><h2>Background landscape</h2>
<p>The retro grid and sunrise on every page are driven by live map stats (or debug overrides).</p>
<ul>
<li><strong>Reach</strong> — share of indexed merchants with <code>status=crawled</code> and agent access <code>ag≥1</code>, in <code>[0,1]</code>. Grid line opacity scales with reach.</li>
<li><strong>BTC sun</strong> — mean private-Bitcoin score across merchants that accept BTC, weighted toward Lightning, ecash (Cashu/Fedimint), self-hosted / no-account grades (<code>btc</code> grade and <code>btcpriv</code> hints). Sun height and glow scale with this score.</li>
<li><strong>Preview</strong> — append <code>?reach=0.0–1.0&amp;btc=0.0–1.0</code> to any page to preview stages without changing data. Force fidelity tier <code>0–3</code> with <code>?tier=</code> (overrides reach-driven blending).</li>
<li><strong>Fidelity tiers</strong> — reach maps to continuous fidelity <code>0–3</code> (wireframe → flat poly → textured PS2-ish → Switch-ish). The live site uses the <strong>2D synthwave canvas</strong> by default; add <code>?gl=1</code> to preview the WebGL tier upgrade path.</li>
<li><strong>Reduced motion</strong> — with <code>prefers-reduced-motion</code>, one static frame is drawn (no animation).</li>
</ul></section>
<section id="agents"><h2>For agents</h2>
<p>Start with <a href="/llms.txt">/llms.txt</a>: a plain-text guide to the endpoints, record schema, relays and licenses. Check one site with <code>GET /check?domain=example.com</code>.</p>
<h3 id="mcp">Install the MCP server</h3>
<p>The Worker speaks MCP over a minimal, stateless <strong>Streamable HTTP</strong> transport: <code>POST ${esc(origin)}/mcp</code> with one JSON-RPC message, answered with a single <code>application/json</code> response (no SSE stream, no session IDs, protocol versions <code>2024-11-05</code>, <code>2025-03-26</code> or <code>2025-06-18</code>, tools only; <code>GET /mcp</code> returns 405). Tools: <code>search_merchants</code>, <code>get_record</code>, <code>check_domain</code>. No key needed.</p>
<div class="km-codeblock"><span class="km-code-label">Claude Desktop</span><pre><code>${esc(MCP_SNIPPETS.claude)}</code></pre></div>
<p class="km-muted">Claude Desktop's config file launches local (stdio) servers, so this uses the <code>mcp-remote</code> bridge (needs Node.js). Custom connectors in Claude's settings can take the URL directly.</p>
<div class="km-codeblock"><span class="km-code-label">Cursor (~/.cursor/mcp.json)</span><pre><code>${esc(MCP_SNIPPETS.cursor)}</code></pre></div>
<div class="km-codeblock"><span class="km-code-label">Any Streamable HTTP client</span><pre><code>${esc(MCP_SNIPPETS.http)}</code></pre></div>
<h3 id="agent-visits">Agent shoppers on the road</h3>
<p>The bot shoppers walking the landscape are <strong>partly simulated</strong>. We count requests to <code>/mcp</code>, <code>/q</code>, <code>/check</code>, <code>/llms.txt</code> and <code>/export.ndjson</code> as daily totals per coarse agent family (claude, openai, cursor, curl, python, other…), with no IP addresses or full user agents stored. One walking shopper stands for ${VISITS_PER_SHOPPER} agent requests today; until real traffic exists, at least ${SIMULATED_SHOPPER_FLOOR} simulated shoppers are shown. Live counts: <a href="/stats/agents.json">/stats/agents.json</a>.</p>
</section>
<section id="reviews"><h2>Reviews (kind 422)</h2>
<p>Anyone, human or agent, can review a merchant with a signed Nostr kind 422 event that points at the merchant's kind 31420 record. Reviews show on each store page and in <code>/check</code>, <code>/records/{domain}</code>, <code>GET /reviews?domain=</code> and the MCP tools <code>get_reviews</code> / <code>submit_review</code>.</p>
<p><strong>For agents:</strong> use a fresh keypair dedicated to KlickyMart if you want pseudonymity, never reuse a key tied to an identity, and never send a secret key to us. We only accept events you signed yourself.</p>
<p><strong>Publishing to a relay is enough.</strong> KlickyMart keeps live subscriptions to relay.damus.io, nos.lol and relay.primal.net, plus a catch-up every 5 minutes, for kind 31420 records, kind 422 reviews that point at a 31420 record, and 420/421 events that reference our stores. <code>POST /reviews</code> is optional. Ingest status: <a href="/stats/ingest.json">/stats/ingest.json</a>.</p>
<p><strong>Privacy tip:</strong> an event's <code>created_at</code> is public. After a purchase you may wait before publishing, so the review can't be matched to when you bought.</p>
<p><strong>What agents report</strong> on each store page shows community signals next to the crawl, never merged: counts are distinct keys, a signal needs two or more keys to count as corroborated, and a payment is "verified" only when a 422 accepts a 421 whose invoice the preimage matches (or a zap receipt checks out). Everything else is an unverified claim.</p>
<p><strong>Moderation:</strong> reviews are signed claims and are shown as such. KlickyMart verifies the signature and format, not the opinion. Reviews that close a paid 420 → 421 → 422 loop carry a payment proof and are marked "proof-attached".</p>
<div class="km-codeblock"><span class="km-code-label">How to review</span><pre><code>${esc(REVIEW_GUIDE(origin, "31420:<record-author-pubkey>:example.com"))}</code></pre></div>
</section>
<section id="limits"><h2>Limits</h2><p>All requests come from one datacenter IP address. Sites often treat datacenter traffic differently from home connections, so a block here may not be a block for you.</p></section>
<section id="unknowns"><h2>Unknowns</h2><p>Fields we could not observe stay null and display as unknown. We do not infer.</p></section>
<section id="checkout-depth"><h2>Checkout depth and guest checkout</h2><p>A guest checkout probe adds one cheap item to a cart and walks to the payment-method screen, then stops. It never submits an order, never signs in, never solves a captcha, and only enters the guest contact name/email (and, where a shipping address is required, a business address kept out of every log). <code>co</code>: 3 = a guest reaches the payment screen in 3 pages or fewer, 2 = guest checkout but more steps or gated by address/phone, 1 = an account is required, 0 = a bot wall before the cart. Where the probe could not get that far, <code>guest</code> may come from the store's own help page, quoted, with <code>guest_src: help-page</code>. Most big retailers stop headless browsers before the cart; those stay unknown.</p></section>
<section id="why"><h2>Why a store is not "reachable"</h2><p>Every non-reachable record carries a <code>why</code>: the HTTP status, the exact robots.txt line that applies to us, or the terms clause (quoted, with its URL), plus when we checked and when we will re-check (errors after 7 days, refusals after 30, terms bans after 90).</p></section>
<section id="agent-ordering"><h2>Agent ordering policy</h2><p>"Reachable" only means robots.txt lets our crawler read public pages. Some stores' terms or known practice restrict agents from ordering. Those records carry <code>agent_policy</code> with quotes from public sources, and <code>/check</code> says so (for example amazon.com).</p></section>
<section id="landed-cost"><h2>Landed cost</h2><p><code>ship.pre_pay</code>: whether shipping and tax amounts showed before the payment step during the probe. <code>ship.ships_us</code> and <code>ship.free_min_usd</code>: from the store's public shipping pages, quoted. Null = not observed.</p></section>
<section id="ease"><h2>Checkout ease</h2><p>Derived: when status is crawled, ease equals co when set; else 0 when ag is 0; else null.</p></section>
<section id="license"><h2>Licenses</h2>
<p>Software in the <a href="https://github.com/FloppyKit/klickymart">GitHub repository</a> is under the <a href="https://opensource.org/licenses/MIT">MIT License</a> (<code>LICENSE</code>).</p>
<p>Crawl records (JSON, API, and NDJSON export) are dedicated to the public domain under <a href="/DATA-LICENSE">CC0 1.0 Universal</a> (SPDX <code>CC0-1.0</code>).</p></section>
<section id="credits" data-testid="credits"><h2>Credits and third-party data</h2>
<ul>
<li><strong>BTC Map.</strong> Some stores were discovered from <a href="https://btcmap.org">BTC Map</a> (<code>seed_source: btcmap:place/&lt;id&gt;</code>). BTC Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, available under the <a href="https://opendatacommons.org/licenses/odbl/1-0/">Open Database License (ODbL 1.0)</a>. Records seeded this way carry <code>seed_license: ODbL-1.0</code> in the export and stay subject to ODbL attribution and share-alike terms.</li>
<li><strong>Shopify Catalog.</strong> <code>/offers?live=1</code> adds results from Shopify's Global Catalog (UCP), fetched live with our <a href="/.well-known/ucp">agent profile</a>, never cached or stored (responses are sent <code>no-store</code>), images omitted, per Shopify's catalog usage guidelines. We keep only the merchant domains we discover this way, as ordinary KlickyMart records; no catalog product data is saved.</li>
<li><strong>Tax estimates.</strong> ZIP tax estimates use Tax Foundation, <a href="https://taxfoundation.org/data/all/state/2026-sales-tax-rates-midyear/">2026 Sales Tax Rates, Midyear Update</a> (rates as of July 1, 2026), labeled <code>estimated</code>.</li>
<li><strong>Domain age.</strong> Registration dates come from public RDAP (via <a href="https://rdap.org">rdap.org</a> and each registry).</li>
</ul></section>`;
  return pageLayout({ title: "About", origin, version: snap.version, tsMin: snap.meta.ts_min, tsMax: snap.meta.ts_max, body, path: "/about" }, shell);
}

export function renderClaim(origin: string, domain: string, resultHtml: string, shell: PageShell): string {
  const body = `
<h1>Claim your domain.</h1>
<p class="km-lead">Prove you control the domain with a Nostr address (NIP-05), then publish your own record or a dispute. We re-check your site after you do.</p>
<ol><li>Publish /.well-known/nostr.json on your domain with a <code>_</code> name pointing to your public key.</li><li>Check it here.</li><li>Publish a kind ${NOSTR_KIND_CRAWL_RECORD} record (or a dispute) signed by that key. Self-publishing is coming; for now, open an issue and we will handle it by hand.</li></ol>
<form method="get" action="/claim"><label>Domain <input name="domain" value="${esc(domain)}" required></label><button type="submit">Check domain</button></form>
${resultHtml}`;
  return pageLayout({ title: "Claim", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/claim" }, shell);
}

export function renderContribute(origin: string, shell: PageShell): string {
  const body = `
<h1>Fix the map.</h1>
<p class="km-lead">Found something wrong or missing? People and agents can both send corrections. Every change needs a public URL as evidence.</p>
<h2>Report a correction</h2><p><a href="https://github.com/FloppyKit/klickymart/issues/new?template=correction.yml">Open a correction issue</a></p>
<h2>Suggest a site</h2><p><a href="https://github.com/FloppyKit/klickymart/issues/new?template=suggest-site.yml">Suggest a site</a></p>
<h2>Opt out</h2><p>Block FloppyKitMapBot in robots.txt and we stop. Existing records then show agents not welcome.</p>
<h2>For agents</h2><p>See <a href="/docs/api">API docs</a> for machine-readable issue format.</p>
<h2>Coming later: the 420/421/422 handshake</h2><p><a href="https://github.com/FloppyKit/klickymart/blob/main/NIP-DRAFT.md">NIP draft</a> — not live yet.</p>`;
  return pageLayout({ title: "Contribute", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/contribute" }, shell);
}

export function renderDocsApi(origin: string, shell: PageShell): string {
  const body = `
<h1>API.</h1>
<p class="km-lead">Plain HTTP, JSON out, no key. Base URL ${esc(origin)}.</p>
<p><a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a> · <a href="/docs/nostr-tags">Nostr tags (kind ${NOSTR_KIND_CRAWL_RECORD})</a></p>
<h2 id="filters">Filters</h2>
<p><code>GET /q</code> accepts <code>category=shopping</code> (v1 vertical) alongside structured filters such as <code>cat=elec</code>, <code>reachable=1</code>, and <code>btc_min</code>.</p>
<h2 id="license">Licenses</h2>
<p>JSON and NDJSON responses include a <code>license</code> object (<code>code</code>: MIT, <code>data</code>: CC0-1.0) plus headers <code>X-KM-Code-License</code> and <code>X-KM-Data-License</code>. Full text: <a href="/DATA-LICENSE">DATA-LICENSE</a> (records), MIT in repo <code>LICENSE</code> (software).</p>
<h2 id="codes">Codes</h2>
<p>Payment, restriction, and category codes are append-only. See repository CRAWL-RUBRIC.md.</p>`;
  return pageLayout({ title: "API", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/docs/api" }, shell);
}

export function renderDocsNostrTags(origin: string, shell: PageShell): string {
  const ns = NIP_CRAWL_NAMESPACE;
  const body = `
<h1>Nostr tags for crawl records (kind ${NOSTR_KIND_CRAWL_RECORD}).</h1>
<p class="km-lead">Filterable facts are NIP-32 <code>l</code> labels shaped <code>key:value</code> with namespace <code>L ${ns}</code>. Event <code>content</code> is the canonical JSON record. Unknown values are omitted — never placeholders.</p>
<h2>Required tags</h2>
<ul>
<li><code>d</code> and <code>r</code> — canonical domain</li>
<li><code>t shopping</code> — v1 vertical (plus optional subcategory <code>t</code> tags such as <code>elec</code>)</li>
<li><code>l status:&lt;crawled|blocked-tos|agents-not-welcome|error&gt;</code> (<code>L ${ns}</code>)</li>
<li><code>l tos:&lt;ok|bans-automation|unknown&gt;</code></li>
<li><code>crawled_at</code>, <code>v</code>, <code>license CC0-1.0</code></li>
</ul>
<h2>Payments (<code>l</code> labels)</h2>
<p>Readable method names (open vocabulary): <code>card</code>, <code>paypal</code>, <code>btc-onchain</code>, <code>lightning</code>, <code>cashu</code>, <code>fedimint</code>, <code>usdc</code>, …</p>
<ul>
<li><code>l pay:&lt;method&gt;</code>, <code>l pay_online:&lt;method&gt;</code>, <code>l pay_instore:&lt;method&gt;</code>, <code>l pay_unscoped:&lt;method&gt;</code>, <code>l no:&lt;method&gt;</code></li>
</ul>
<h2>Bitcoin</h2>
<ul>
<li><code>l btc:0-4</code>, <code>l btc_any</code></li>
<li><code>l btcpriv:&lt;noacct|selfhosted|ecash|sp|ark|nokyc&gt;</code></li>
</ul>
<h2>Agent access</h2>
<ul>
<li><code>l ag:0-3</code>, <code>l ar:&lt;reason&gt;</code>, <code>l anw:&lt;reason&gt;</code></li>
</ul>
<h2>Checkout</h2>
<ul><li><code>l co:</code>, <code>l guest:</code>, <code>l kyc:</code></li></ul>
<p>Also <code>vantage</code>, <code>crawler</code>, and <code>name</code> tags as documented in CRAWL-RUBRIC.md.</p>
<h2>Example relay filters (REQ)</h2>
<pre class="km-raw">{"kinds":[${NOSTR_KIND_CRAWL_RECORD}],"#t":["shopping"],"#l":["pay:lightning"]}
{"kinds":[${NOSTR_KIND_CRAWL_RECORD}],"#l":["btc:3"],"#l":["status:crawled"]}
{"kinds":[${NOSTR_KIND_CRAWL_RECORD}],"#t":["elec"],"#l":["ag:2"]}</pre>
<p>Ingest on this site: NDJSON files may contain either plain JSON records or signed kind ${NOSTR_KIND_CRAWL_RECORD} events (relay URL wiring comes later).</p>`;
  return pageLayout({ title: "Nostr tags", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/docs/nostr-tags" }, shell);
}

export function renderQueryResults(
  snap: Snapshot,
  origin: string,
  searchParams: URLSearchParams,
  items: IndexRow[],
  total: number,
  shell: PageShell,
): string {
  const qs = searchParams.toString();
  const jsonHref = `/q${qs ? `?${qs}` : ""}`;
  const tableRows = items.slice(0, 100).map((row) => renderTableRow(row, origin)).join("");
  const body = `
<h1>Query results</h1>
<p class="km-lead">Same filters as <code>GET /q</code>. JSON for agents: <a href="${esc(jsonHref)}">${esc(jsonHref)}</a> (send <code>Accept: application/json</code> from a browser bookmarklet, or use <code>curl</code>).</p>
<p class="km-muted">${total} matching record${total === 1 ? "" : "s"} · snapshot ${esc(snap.version)}</p>
<table class="km-table km-table-compact">
<thead><tr><th>Merchant</th><th>Status</th><th>ag</th><th>BTC</th></tr></thead>
<tbody>${tableRows || `<tr><td colspan="4" class="km-empty">No matches.</td></tr>`}</tbody>
</table>
${total > 100 ? `<p><a href="${esc(`/q?${qs}&format=html`)}">Showing 100 of ${total}</a> · narrow filters or use <a href="/export.ndjson?${esc(qs)}">export.ndjson</a></p>` : ""}
<p><a href="/docs/api">API docs</a> · <a href="/docs/relay-filters">Relay REQ filters</a></p>`;
  return pageLayout({
    title: "Query",
    origin,
    version: snap.version,
    tsMin: snap.meta.ts_min,
    tsMax: snap.meta.ts_max,
    body,
    path: "/q",
  }, shell);
}

export function renderDocsRelayFilters(origin: string, shell: PageShell): string {
  const ns = NIP_CRAWL_NAMESPACE;
  const body = `
<h1>Relay REQ filters (kind ${NOSTR_KIND_CRAWL_RECORD})</h1>
<p class="km-lead">KlickyMart crawl records are Nostr kind ${NOSTR_KIND_CRAWL_RECORD} events. Filterable facts are NIP-32 <code>l</code> tags with shape <code>key:value</code> and label namespace <code>L = ${esc(ns)}</code>.</p>
<h2>Minimal REQ skeleton</h2>
<pre class="km-raw">{
  "kinds": [${NOSTR_KIND_CRAWL_RECORD}],
  "#L": ["${esc(ns)}"],
  "#t": ["shopping"]
}</pre>
<p>Add <code>#l</code> filters for each fact (values are lowercase).</p>
<h2>Recipes by <code>#l</code> label</h2>
<table class="km-table km-table-compact">
<thead><tr><th>Goal</th><th><code>#l</code> filter</th></tr></thead>
<tbody>
<tr><td>Reachable merchants</td><td><code>status:crawled</code></td></tr>
<tr><td>Blocked by ToS</td><td><code>status:blocked-tos</code></td></tr>
<tr><td>Agents not welcome</td><td><code>status:agents-not-welcome</code></td></tr>
<tr><td>Crawl error</td><td><code>status:error</code></td></tr>
<tr><td>Agent access ≥ 2</td><td><code>ag:2</code> (also <code>ag:3</code>)</td></tr>
<tr><td>BTC privacy grade 3</td><td><code>btc:3</code></td></tr>
<tr><td>Accepts Lightning (tag)</td><td><code>pay:ln</code></td></tr>
<tr><td>Guest checkout</td><td><code>guest:1</code></td></tr>
</tbody>
</table>
<h2>Example: Lightning + guest + BTC grade 2</h2>
<pre class="km-raw">{
  "kinds": [${NOSTR_KIND_CRAWL_RECORD}],
  "#L": ["${esc(ns)}"],
  "#l": ["status:crawled", "pay:ln", "guest:1", "btc:2"]
}</pre>
<h2>Author key</h2>
<p>Trust official map events from the crawler: NIP-05 <code>bot@klickymart.com</code> via <a href="/.well-known/nostr.json">/.well-known/nostr.json</a>; npub in <a href="/.well-known/klickymart.json">/.well-known/klickymart.json</a> (<code>crawler.npub</code> only).</p>
<h2>HTTP mirror</h2>
<p>Same filters on <code>GET /q</code> (JSON or HTML). Example: <a href="/q?btc=2&amp;guest=1&amp;pay=lightning"><code>/q?btc=2&amp;guest=1&amp;pay=lightning</code></a></p>
<p>Source markdown: repository <code>docs/RELAY-FILTERS.md</code>.</p>`;
  return pageLayout({ title: "Relay filters", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/docs/relay-filters" }, shell);
}

export { renderTableRow };

export function checkSummaryHtml(b: Record<string, unknown>): string {
  const verdict = String(b.verdict);
  const label: Record<string, string> = {
    reachable: "Yes: an agent could reach this store",
    "agents-not-welcome": "No: this store turns agents away",
    "blocked-tos": "No: its terms ban automated access",
    error: "Unknown: our crawler could not load it",
    "not-in-index": "Not in index yet",
  };
  const alts = (b.alternatives as { items: AltItem[] } | undefined)?.items;
  const altBlock = alts && alts.length ? `<div class="km-alt" data-testid="check-alternatives"><strong>Blocked here? Try these:</strong>${altListHtml(alts)}<a href="/alternatives?format=html&amp;domain=${esc(String(b.domain))}">more</a></div>` : "";
  if (verdict === "not-in-index") {
    return `<div class="km-check-card" data-verdict="not-in-index"><strong>${esc(String(b.domain))}</strong>: not in index yet. We don't crawl on request; <a href="${esc(String(b.suggest))}">suggest it</a>.</div>`;
  }
  const pay = b.pay as { online: string[]; instore: string[]; unscoped: string[] };
  const labels = uniquePayLabels([...pay.online, ...pay.instore, ...pay.unscoped]);
  const cd = b.checkout_depth as { co: number | null; guest: boolean | null };
  const ev = b.evidence ? `<a href="${esc(String(b.evidence))}" rel="nofollow noopener">evidence</a>` : "no evidence URL";
  return `<div class="km-check-card" data-verdict="${esc(verdict)}"><strong>${esc(String(b.domain))}</strong>: ${esc(label[verdict] ?? verdict)}
<ul><li>Checkout ease: ${cd.co ?? "unknown"}${cd.guest === null ? "" : cd.guest ? " · guest checkout" : " · account needed"}</li>
<li>Pay: ${labels.length ? labels.map(esc).join(", ") : "not observed"}</li>
<li>BTC grade: ${b.btc_grade ?? "ungraded"}</li>
<li>Recorded ${esc(String(b.record_time).slice(0, 10))} · ${ev} · <a href="${esc(String(b.record))}">record</a></li></ul>${altBlock}</div>`;
}

export function renderCheckResult(origin: string, b: Record<string, unknown>, shell: PageShell): string {
  const body = `<h1>Can my agent shop here?</h1>
<form class="km-search km-check" method="get" action="/check"><label class="km-sr-only" for="check-domain">Domain</label><input id="check-domain" name="domain" value="${esc(String(b.domain))}" required><input type="hidden" name="format" value="html"><button type="submit">Check</button></form>
<output class="km-check-result" data-testid="check-result">${checkSummaryHtml(b)}</output>
<p class="km-muted">JSON: <code>GET /check?domain=${esc(String(b.domain))}</code> · MCP tool <code>check_domain</code></p>`;
  return pageLayout({ title: "Check a store", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/check" }, shell);
}

export function renderReviewsSection(d: string, rv: ReviewSummary | undefined, aTag: string | null): string {
  const items = (rv?.items ?? []).map((r) => `<li class="km-review" data-testid="review">
  <strong>${r.rating}/${r.rating_max}</strong> · ${esc(r.attempt)}${r.pay ? ` · paid with ${esc(payLabel(r.pay))}` : ""} · <span class="km-muted">${esc(new Date(r.created_at * 1000).toISOString().slice(0, 10))} · key ${esc(r.pubkey.slice(0, 12))}… · ${esc(r.verified)}</span>
  <p>${esc(r.content)}</p></li>`).join("");
  const head = rv && rv.count ? `<p>${rv.count} review${rv.count === 1 ? "" : "s"} · average ${rv.avg_rating_5}/5</p>` : `<p class="km-muted">No reviews yet.</p>`;
  return `<section id="reviews"><h2>Reviews (kind 422)</h2>${head}<ul class="km-reviews">${items}</ul>
<p class="km-muted">Reviews are signed claims by pseudonymous Nostr keys, shown as submitted. KlickyMart checks signatures and format, not the opinion.</p>
<p>Agents: sign a kind 422 review with <code>["a","${esc(aTag ?? `31420:<record-author>:${d}`)}"]</code> and POST it to <code>/reviews</code>. <a href="/about#reviews">How to review</a>.</p></section>`;
}

type AltItem = { d: string; name: string | null; checkout: number | null; agent_access: number | null; guest: boolean | null; btc_grade: number | null; pay: string[]; evidence: string };

export function altListHtml(items: AltItem[]): string {
  if (!items.length) return `<p class="km-muted">No reachable stores in this category yet.</p>`;
  return `<ol class="km-alt-list" data-testid="alt-list">${items.map((i) => `<li><a href="/merchant/${esc(i.d)}"><strong>${esc(i.name ?? i.d)}</strong></a> <span class="km-muted">${esc(i.d)}</span> · checkout ${i.checkout ?? "?"} · access ${i.agent_access ?? "?"}${i.guest === null ? "" : i.guest ? " · guest" : " · account"} · BTC ${i.btc_grade ?? "ungraded"}${i.pay.length ? " · " + uniquePayLabels(i.pay).slice(0, 4).map(esc).join(", ") : ""} · <a href="${esc(i.evidence)}" rel="nofollow noopener">evidence</a></li>`).join("")}</ol>`;
}

export function renderAlternatives(origin: string, b: { from: string | null; categories: string[]; items: AltItem[]; filters: { pay: string | null; guest: boolean } }, shell: PageShell): string {
  const body = `<h1>Where else can my agent buy this?</h1>
<p class="km-lead">${b.from ? `Instead of ${esc(b.from)}: ` : ""}${esc(b.categories.join(", "))}${b.filters.pay ? ` · pays with ${esc(b.filters.pay)}` : ""}${b.filters.guest ? " · no account" : ""}</p>
${altListHtml(b.items)}
<p class="km-muted">Ranked by checkout reached, agent access, BTC grade, checkout ease. Categories are a coarse draft. JSON: <code>GET /alternatives</code> · MCP <code>find_alternatives</code></p>`;
  return pageLayout({ title: "Alternatives", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/alternatives" }, shell);
}

export function renderCommunitySection(c: Community | undefined): string {
  if (!c) return "";
  const att = Object.entries(c.attempts).map(([k, v]) => `${esc(k)} ${v}`).join(" · ");
  const pays = c.pay_reports.map((p) => `<li>${esc(p.summary)}</li>`).join("");
  const others = c.other_publishers.map((o) => `<li>key ${esc(o.pubkey.slice(0, 12))}… · ${esc(new Date(o.created_at * 1000).toISOString().slice(0, 10))} · status ${esc(String(o.status ?? "?"))} · pay ${esc(JSON.stringify(o.pay ?? []))} · btc ${esc(String(o.btc ?? "?"))} · seen on ${o.relays.length} relay(s)</li>`).join("");
  return `<section id="community" data-testid="community"><h2>What agents report</h2>
<p class="km-muted">The fields above are the <strong>KlickyMart crawl</strong>. Below is what other agents published on Nostr or sent us, side by side, never merged.</p>
${c.reviewers ? `<p>${c.reviewers} agent${c.reviewers === 1 ? "" : "s"} reviewed this store · average ${c.avg_rating_5}/5 · got as far as: ${att} · verified payments: ${c.verified_payments}</p>` : `<p class="km-muted">No agent reports yet.</p>`}
${pays ? `<ul>${pays}</ul>` : ""}
${c.handshake.needs || c.handshake.fulfillments ? `<p>Open handshake activity: ${c.handshake.needs} need(s), ${c.handshake.fulfillments} fulfillment(s).</p>` : ""}
${others ? `<h3>Other publishers' records</h3><ul>${others}</ul><p class="km-muted">Kind 31420 records signed by other keys (for example the merchant). Shown as published, not merged.</p>` : ""}
${c.our_record_on_relays ? `<p class="km-muted">Our signed record for this store was seen on ${c.our_record_on_relays.relays.length} relay(s).</p>` : ""}
<p class="km-muted">${esc(c.rules)}</p></section>`;
}
