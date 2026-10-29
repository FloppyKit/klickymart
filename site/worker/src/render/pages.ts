import type { IndexRow, Snapshot } from "../index-mem";
import { esc, eyebrow, gradeBadge, layout, statusPill } from "./layout";
import { merchantUrl, parseRaw, payLabel, rowToCompact } from "../records-api";
import { computeStats } from "../records-api";

export function renderHome(snap: Snapshot, origin: string, q: string | null, items: IndexRow[]): string {
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
<section class="km-hero km-grid-bg">
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

  return layout({
    title: "Where agents shop",
    origin,
    version: snap.version,
    tsMin: snap.meta.ts_min,
    tsMax: snap.meta.ts_max,
    body,
    path: "/",
  });
}

export function renderDashboard(snap: Snapshot, origin: string, searchParams: URLSearchParams, items: IndexRow[], total: number): string {
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

  const body = `
<h1>The map, in numbers.</h1>
<p class="km-lead">Every site we checked, what stopped us, and what they accept. Click any cell to see the quote behind it.</p>
<div class="km-tiles">${tiles.map((t) => `<a class="km-tile" href="${esc(t.href)}"><span class="km-tile-n">${t.count}</span><span class="km-tile-l">${esc(t.label)}</span></a>`).join("")}</div>
<h2 class="km-h2">Bitcoin grade, all sites</h2>
<svg class="km-chart" viewBox="0 0 260 120" role="img" aria-label="Bitcoin grade histogram">${bars}</svg>
<form class="km-filters" method="get" action="/dashboard">
  <details><summary>Filters</summary>
  <label for="status-filter">Status</label>
  <select id="status-filter" name="status" aria-label="Filter by status"><option value="">Any</option><option value="crawled">crawled</option><option value="agents-not-welcome">agents-not-welcome</option></select>
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

  return layout({ title: "Dashboard", origin, version: snap.version, tsMin: snap.meta.ts_min, tsMax: snap.meta.ts_max, body, path: "/dashboard" });
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

export function renderMerchant(row: IndexRow, origin: string): string {
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

  return layout({ title: row.name ?? row.d, origin, version: "—", tsMin: row.ts, tsMax: row.ts, body, path: `/merchant/${row.d}` });
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

export function render404(origin: string): string {
  const body = `<h1>Nothing here. Search the map instead.</h1>
<form class="km-search" method="get" action="/"><input name="q" placeholder="Search"><button type="submit">Search</button></form>`;
  return layout({ title: "Not found", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "" });
}

export function renderAbout(origin: string, snap: Snapshot): string {
  const body = `
<h1>How this map is made.</h1>
<p class="km-lead">One crawler, public pages only, honest user agent, and a quote for every claim.</p>
<section id="limits"><h2>Limits</h2><p>All requests come from one datacenter IP address. Sites often treat datacenter traffic differently from home connections, so a block here may not be a block for you.</p></section>
<section id="unknowns"><h2>Unknowns</h2><p>Fields we could not observe stay null and display as unknown. We do not infer.</p></section>
<section id="ease"><h2>Checkout ease</h2><p>Derived: when status is crawled, ease equals co when set; else 0 when ag is 0; else null.</p></section>
<p>Data licence: CC0 for records (pending confirmation). Code: repo licence.</p>`;
  return layout({ title: "About", origin, version: snap.version, tsMin: snap.meta.ts_min, tsMax: snap.meta.ts_max, body, path: "/about" });
}

export function renderClaim(origin: string, domain: string, resultHtml: string): string {
  const body = `
<h1>Claim your domain.</h1>
<p class="km-lead">Prove you control the domain with a Nostr address (NIP-05), then publish your own record or a dispute. We re-check your site after you do.</p>
<ol><li>Publish /.well-known/nostr.json on your domain with a <code>_</code> name pointing to your public key.</li><li>Check it here.</li><li>Publish a kind 31420 record (or a dispute) signed by that key. Self-publishing is coming; for now, open an issue and we will handle it by hand.</li></ol>
<form method="get" action="/claim"><label>Domain <input name="domain" value="${esc(domain)}" required></label><button type="submit">Check domain</button></form>
${resultHtml}`;
  return layout({ title: "Claim", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/claim" });
}

export function renderContribute(origin: string): string {
  const body = `
<h1>Fix the map.</h1>
<p class="km-lead">Found something wrong or missing? People and agents can both send corrections. Every change needs a public URL as evidence.</p>
<h2>Report a correction</h2><p><a href="https://github.com/FloppyKit/klickymart/issues/new?template=correction.yml">Open a correction issue</a></p>
<h2>Suggest a site</h2><p><a href="https://github.com/FloppyKit/klickymart/issues/new?template=suggest-site.yml">Suggest a site</a></p>
<h2>Opt out</h2><p>Block FloppyKitMapBot in robots.txt and we stop. Existing records then show agents not welcome.</p>
<h2>For agents</h2><p>See <a href="/docs/api">API docs</a> for machine-readable issue format.</p>
<h2>Coming later: the 420/421/422 handshake</h2><p><a href="https://github.com/FloppyKit/klickymart/blob/main/NIP-DRAFT.md">NIP draft</a> — not live yet.</p>`;
  return layout({ title: "Contribute", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/contribute" });
}

export function renderDocsApi(origin: string): string {
  const body = `
<h1>API.</h1>
<p class="km-lead">Plain HTTP, JSON out, no key. Base URL ${esc(origin)}.</p>
<p><a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a></p>
<h2 id="codes">Codes</h2>
<p>Payment, restriction, and category codes are append-only. See repository CRAWL-RUBRIC.md.</p>`;
  return layout({ title: "API", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/docs/api" });
}

export { renderTableRow };
