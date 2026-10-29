import type { IndexRow, Snapshot } from "../index-mem";
import { esc, eyebrow, gradeBadge, layout, statusPill } from "./layout";
import type { PageShell } from "./page-shell";
import { merchantUrl, parseRaw, payLabel, rowToCompact } from "../records-api";
import { computeStats } from "../records-api";
import { NOSTR_KIND_CRAWL_RECORD, NIP_CRAWL_NAMESPACE } from "../nostr-kinds";

function pageLayout(
  base: Parameters<typeof layout>[0],
  shell: PageShell,
): string {
  return layout({
    ...base,
    previewData: shell.previewData,
    landscapeReach: shell.landscapeReach,
    landscapeBtc: shell.landscapeBtc,
  });
}

export function renderHome(snap: Snapshot, origin: string, q: string | null, items: IndexRow[], shell: PageShell): string {
  const quick = [
    { href: "/dashboard?pay_group=lightning&scope=any", label: "Takes Lightning" },
    { href: "/dashboard?btc_min=3", label: "BTC grade 3+" },
    { href: "/dashboard?reachable=1", label: "Reachable by agents" },
    { href: "/dashboard?guest=1", label: "Guest checkout" },
  ];
  const rows = items.slice(0, 20).map((row) => {
    const c = rowToCompact(row, origin);
    const pays = [...c.pay.online, ...c.pay.instore, ...c.pay.unscoped].slice(0, 4)
      .map((p) => `<span class="km-pay-chip">${esc(payLabel(p))}</span>`).join("");
    return `<li class="km-result-row">
      <a href="${esc(merchantUrl(origin, row.d))}"><strong>${esc(row.name ?? row.d)}</strong></a>
      <span class="km-muted">${esc(row.d)}</span>
      ${statusPill(row.status)} ${gradeBadge(row.btc)}
      <span class="km-pay-list">${pays || "<span class=\"km-muted\">unknown</span>"}</span>
    </li>`;
  }).join("");

  const body = `
<section class="km-hero km-hero-panel">
  ${eyebrow("OPEN DATA · SIGNED RECORDS · NO LOGIN")}
  <h1>Where agents shop.</h1>
  <p class="km-lead">Which stores a software agent can reach, how checkout works, and every way they let you pay, with Bitcoin graded for privacy. Each record links to the page it came from.</p>
  <form class="km-search" method="get" action="/">
    <label class="km-sr-only" for="q">Search</label>
    <input id="q" name="q" value="${esc(q ?? "")}" placeholder="Search merchants or domains">
    <button type="submit">Search</button>
  </form>
</section>
<section class="km-section">
  <h2 class="km-h2">Start with</h2>
  <ul class="km-quick">${quick.map((l) => `<li><a class="km-btn km-btn-ghost" href="${esc(l.href)}">${esc(l.label)}</a></li>`).join("")}</ul>
</section>
<section class="km-section">
  <ul class="km-results">${rows || `<li class="km-empty">No sites match. Try fewer filters.</li>`}</ul>
</section>
<section class="km-section km-agents">
  <h2 class="km-h2">For agents</h2>
  <p>Query the map over HTTP, MCP, or a plain NDJSON file. No key needed.</p>
  <div class="km-codeblock"><pre><code>curl '${origin}/q?reachable=1&amp;limit=5'</code></pre></div>
  <div class="km-codeblock"><pre><code>${origin}/mcp</code></pre></div>
  <div class="km-codeblock"><pre><code>curl '${origin}/export.ndjson'</code></pre></div>
</section>`;

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
    records: number;
  };
  const reachable = snap.rows.filter((r) => r.status === "crawled" && r.ag !== null && r.ag >= 1).length;
  const tiles = [
    { label: "Reachable", count: reachable, href: "/dashboard?reachable=1" },
    { label: "Blocked by their terms", count: stats.by_status["blocked-tos"] ?? 0, href: "/dashboard?status=blocked-tos" },
    { label: "Agents not welcome", count: stats.by_status["agents-not-welcome"] ?? 0, href: "/dashboard?status=agents-not-welcome" },
    { label: "Errors", count: stats.by_status.error ?? 0, href: "/dashboard?status=error" },
    { label: "Total", count: stats.records, href: "/dashboard" },
  ];

  const hist = stats.btc_histogram ?? {};
  const maxH = Math.max(1, ...Object.values(hist));
  const bars = ["0", "1", "2", "3", "4", "null"].map((k) => {
    const v = hist[k] ?? 0;
    const h = Math.round((v / maxH) * 100);
    const label = k === "null" ? "?" : k;
    return `<g><rect class="km-bar" x="${Number(k === "null" ? 5 : Number(k) * 40)}" y="${100 - h}" width="32" height="${h}"/><text x="${Number(k === "null" ? 5 : Number(k) * 40) + 16}" y="115">${label}</text></g>`;
  }).join("");

  const tableRows = items.slice(0, 100).map((row) => renderTableRow(row, origin)).join("");

  const categoryVal = searchParams.get("category") ?? "";
  const body = `
<h1>The map, in numbers.</h1>
<p class="km-lead">Every site we checked, what stopped us, and what they accept. Click any cell to see the quote behind it.</p>
<div class="km-tiles">${tiles.map((t) => `<a class="km-tile" href="${esc(t.href)}"><span class="km-tile-n">${t.count}</span><span class="km-tile-l">${esc(t.label)}</span></a>`).join("")}</div>
<h2 class="km-h2">Bitcoin grade, all sites</h2>
<svg class="km-chart" viewBox="0 0 260 120" role="img" aria-label="Bitcoin grade histogram">${bars}</svg>
<form class="km-filters" method="get" action="/dashboard">
  <details open><summary>Filters</summary>
  <label for="category-filter">Category</label>
  <select id="category-filter" name="category" aria-label="Filter by category">
    <option value="">Any</option>
    <option value="shopping"${categoryVal === "shopping" ? " selected" : ""}>Shopping (v1)</option>
  </select>
  <label for="status-filter">Status</label>
  <select id="status-filter" name="status" aria-label="Filter by status"><option value="">Any</option><option value="crawled">crawled</option><option value="agents-not-welcome">agents-not-welcome</option></select>
  <button type="submit" class="km-btn km-btn-ghost">Apply</button>
  </details>
</form>
<table class="km-table">
<caption>Merchant map (${total} sites)</caption>
<thead><tr>
<th scope="col">Merchant</th><th scope="col">Status</th><th scope="col">Agent access</th><th scope="col">BTC grade</th>
</tr></thead>
<tbody>${tableRows}</tbody>
</table>
${total > 100 ? `<p><a href="/dashboard?${esc(searchParams.toString())}&amp;limit=500">Show all</a></p>` : ""}`;

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

export function renderMerchant(row: IndexRow, origin: string, shell: PageShell): string {
  const raw = parseRaw(row.raw_json);
  const issueTitle = encodeURIComponent(`Correction: ${row.d}`);
  const issueBody = encodeURIComponent(`Domain: ${row.d}\n\nDescribe the correction with evidence URL:\n`);
  const body = `
<h1>${esc(row.name ?? row.d)}</h1>
<p><a href="https://${esc(row.d)}/" rel="nofollow noopener">${esc(row.d)}</a> ${statusPill(row.status)} ${gradeBadge(row.btc)}</p>
<section id="access"><h2>Can an agent get in?</h2><p>Agent access: ${row.ag ?? "unknown"}</p></section>
<section id="terms"><h2>Their terms</h2><p>${esc(String(row.tos ?? "unknown"))}</p>${typeof raw.tos_url === "string" ? `<blockquote class="km-quote">${esc(String(raw.tos_q ?? ""))}</blockquote><p><a href="${esc(String(raw.tos_url))}">Source</a></p>` : ""}</section>
<section id="pay"><h2>How you can pay</h2>${renderPayTable(raw)}</section>
<section id="checkout"><h2>Checkout</h2><p>ease: ${row.ease ?? "unknown"} · co: ${row.co ?? "unknown"}</p></section>
<section id="crawl"><h2>About this record</h2><p>Crawled ${new Date(row.ts * 1000).toISOString()}</p>
<details><summary>Raw record</summary><pre class="km-raw">${esc(JSON.stringify(raw, null, 2))}</pre></details></section>
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
    return `<tr id="pay-${i}"><td>${esc(o.c ?? "")}</td><td>${esc(o.scope ?? "—")}</td><td>${esc(o.conf ?? "")}</td><td>${esc(o.q ?? "")}</td><td><a href="${esc(o.url ?? "#")}">↗</a></td></tr>`;
  }).join("");
  return `<table><thead><tr><th>Method</th><th>Scope</th><th>Confidence</th><th>Quote</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
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
<li><strong>Preview</strong> — append <code>?reach=0.0–1.0&amp;btc=0.0–1.0</code> to any page to preview stages without changing data.</li>
<li><strong>Reduced motion</strong> — with <code>prefers-reduced-motion</code>, one static frame is drawn (no animation).</li>
</ul></section>
<section id="limits"><h2>Limits</h2><p>All requests come from one datacenter IP address. Sites often treat datacenter traffic differently from home connections, so a block here may not be a block for you.</p></section>
<section id="unknowns"><h2>Unknowns</h2><p>Fields we could not observe stay null and display as unknown. We do not infer.</p></section>
<section id="ease"><h2>Checkout ease</h2><p>Derived: when status is crawled, ease equals co when set; else 0 when ag is 0; else null.</p></section>
<section id="license"><h2>Licenses</h2>
<p>Software in the <a href="https://github.com/FloppyKit/klickymart">GitHub repository</a> is under the <a href="https://opensource.org/licenses/MIT">MIT License</a> (<code>LICENSE</code>).</p>
<p>Crawl records (JSON, API, and NDJSON export) are dedicated to the public domain under <a href="/DATA-LICENSE">CC0 1.0 Universal</a> (SPDX <code>CC0-1.0</code>).</p></section>`;
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

export { renderTableRow };
