import { APP_RELAYS } from "../nostr-app";
import { anBadgeHtml, anSectionHtml } from "../agent-native";
import { WALLET_GUIDE } from "../wallet";
import type { Community } from "../community";
import type { ReviewSummary } from "../reviews";
import { MCP_SNIPPETS, REVIEW_GUIDE } from "../llms";
import { SIMULATED_SHOPPER_FLOOR, VISITS_PER_SHOPPER } from "../agent-visits";
import type { IndexRow, Snapshot } from "../index-mem";
import { renderAgentPolicy, renderCheckoutDetail, renderV5, renderWhy } from "../explain";
import { awning, esc, eyebrow, gradeBadge, jsonForScript, layout, statusPill } from "./layout";
import type { PageShell } from "./page-shell";
import type { TrustInfo } from "../submissions";
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
    siteTip: shell.siteTip,
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

export function renderDashboard(snap: Snapshot, origin: string, searchParams: URLSearchParams, items: IndexRow[], total: number, shell: PageShell, tiers?: Map<string, TrustInfo>): string {
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

  const N = stats.records;
  const crawledRows = snap.rows.filter((r) => r.status === "crawled");
  const C = crawledRows.length;

  // Q1: how many sites can an agent get into?
  const outcome = [
    { label: "Crawled, agent could read pages", n: reachable, href: "/dashboard?reachable=1" },
    { label: "Crawled, blocked at the front page", n: (stats.by_status.crawled ?? 0) - reachable, href: "/dashboard?status=crawled" },
    { label: "Terms of service ban automation", n: stats.by_status["blocked-tos"] ?? 0, href: "/dashboard?status=blocked-tos" },
    { label: "Turned agents away (robots.txt, 403, block page)", n: stats.by_status["agents-not-welcome"] ?? 0, href: "/dashboard?status=agents-not-welcome" },
    { label: "Site errored when we checked", n: stats.by_status.error ?? 0, href: "/dashboard?status=error" },
  ];

  // Q2: how far into a store does an agent get? (crawled sites only)
  const agWords: [string, string][] = [["3", "Reached the payment screen"], ["2", "Read product and cart pages"], ["1", "Browse only"], ["0", "Blocked at landing"], ["unknown", "Not measured"]];
  const agCount: Record<string, number> = {};
  for (const r of crawledRows) { const k = r.ag === null || r.ag === undefined ? "unknown" : String(r.ag); agCount[k] = (agCount[k] ?? 0) + 1; }
  const depth = agWords.map(([k, label]) => ({ label: `${label} (ag ${k === "unknown" ? "?" : k})`, n: agCount[k] ?? 0, href: k === "unknown" ? "/about#unknowns" : `/q?ag=${k}` }));

  // Q3: where can an agent pay with Bitcoin today? verified (our own probe) vs claimed (store page says so)
  const btcRails: Record<string, string> = { btc: "Bitcoin", ln: "Lightning", lnurl: "Lightning", bolt12: "Lightning", sp: "Silent payments", ark: "Ark", cashu: "Cashu", fedi: "Fedimint", liq: "Liquid", xmr: "Monero" };
  const byD = new Map(snap.rows.map((r) => [r.d, r]));
  const btcStores = (stats.bitcoin_accepting ?? []).map((m) => {
    const row = byD.get(m.d)!;
    const t = tiers?.get(m.d);
    const proof = (t?.trust_proofs ?? []).find((x) => /protocol endpoint/.test(x)) ?? null;
    const ev = ((rowToCompact(row, origin).evidence as { pay?: { c: string; url?: string; neg?: boolean }[] }).pay ?? []).filter((e) => btcRails[e.c] && !e.neg);
    const rails = [...new Set(ev.map((e) => btcRails[e.c]!))];
    return { ...m, ag: row.ag, verified: t?.trust_tier === "verified" && !!proof, proof, rails, evUrl: ev.find((e) => e.url)?.url ?? null };
  }).sort((a, b) => Number(b.verified) - Number(a.verified) || (b.ag ?? -1) - (a.ag ?? -1) || (b.btc ?? -1) - (a.btc ?? -1) || a.d.localeCompare(b.d));
  const nVer = btcStores.filter((b) => b.verified).length;
  const agShort: Record<string, string> = { "3": "payment screen", "2": "product/cart", "1": "browse only", "0": "blocked" };
  const btcRows = btcStores.map((b) => `<tr data-btc-store="${esc(b.d)}" data-verified="${b.verified ? "1" : "0"}">
<td><a href="${esc(merchantUrl(origin, b.d))}">${esc(b.name ?? b.d)}</a><br><span class="km-muted">${esc(b.d)}</span></td>
<td>${b.verified ? `<strong class="km-proof-verified">Verified</strong><br><span class="km-muted">${esc((b.proof ?? "").replace("protocol endpoint: ", "our probe got a real ").replace(" challenge", " payment challenge"))}</span>` : `Claimed<br><span class="km-muted">${b.evUrl ? `<a href="${esc(b.evUrl)}" rel="nofollow noopener">store page says so</a>` : "store page says so"}</span>`}</td>
<td>${esc(b.rails.join(", ") || "Bitcoin")}</td>
<td>${esc(b.ag === null ? "not measured" : agShort[String(b.ag)] ?? String(b.ag))}</td>
<td>${b.btc === null ? `<span class="km-muted">not graded</span>` : gradeBadge(b.btc)}</td></tr>`).join("");

  // Q4: which payment methods do crawled stores show? (distinct stores, any scope)
  const payStores: Record<string, number> = {};
  for (const r of crawledRows) {
    const raw = parseRaw(r.raw_json);
    const seen = new Set<string>();
    for (const sc of ["pay_online", "pay_instore", "pay_unscoped"]) { const l = raw[sc]; if (Array.isArray(l)) for (const c of l) if (typeof c === "string") seen.add(payLabel(c.split(":")[0]!)); }
    for (const l of seen) payStores[l] = (payStores[l] ?? 0) + 1;
  }
  const payBars = Object.entries(payStores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([label, n]) => ({ label, n, href: "" }));

  const barTable = (caption: string, rows: { label: string; n: number; href: string }[], denom: number, unit: string) => `<table class="km-table km-table-compact km-bars"><caption class="km-sr-only">${esc(caption)}</caption><thead><tr><th scope="col">${esc(unit)}</th><th scope="col">Count</th><th scope="col" aria-hidden="true"></th></tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${r.href ? `<a href="${esc(r.href)}">${esc(r.label)}</a>` : esc(r.label)}</th><td class="km-bar-n">${r.n} of ${denom}</td><td class="km-bar-cell" aria-hidden="true"><span class="km-hbar" style="width:${denom ? Math.round((r.n / denom) * 100) : 0}%"></span></td></tr>`).join("")}</tbody></table>`;
  const tableRows = items.slice(0, 100).map((row) => renderTableRow(row, origin)).join("");

  const categoryVal = searchParams.get("category") ?? "";
  const statusVal = searchParams.get("status") ?? "";
  const statusOptions = ["crawled", "agents-not-welcome", "blocked-tos", "error"].map((s) =>
    `<option value="${s}"${statusVal === s ? " selected" : ""}>${s}</option>`,
  ).join("");

  const body = `
<div class="km-store km-dash">
${awning("The map, in numbers.", "Every site we checked, what stopped us, and what they accept.", "h1")}
<section class="km-receipt" data-testid="dash-reach">
<h2 class="km-h2">Can an agent get into these sites?</h2>
<p class="km-muted">All ${N} sites we checked, by what happened when our crawler arrived.</p>
${barTable("Outcome per site", outcome, N, "What happened")}
</section>

<section class="km-receipt" data-testid="dash-btc">
<h2 class="km-h2">Where can an agent pay with Bitcoin today?</h2>
<p><strong>${btcStores.length} of ${N}</strong> sites take Bitcoin or Lightning. <strong>${nVer}</strong> verified: our own probe got a real machine-payable challenge. <strong>${btcStores.length - nVer}</strong> claimed: the store's own page says it accepts Bitcoin, but we have not paid there.</p>
<div class="km-receipt-table"><table class="km-table km-table-compact">
<thead><tr><th scope="col">Store</th><th scope="col">How we know</th><th scope="col">Rails</th><th scope="col">How far an agent got</th><th scope="col">Privacy grade (0–4)</th></tr></thead>
<tbody>${btcRows || `<tr><td colspan="5" class="km-muted">None indexed</td></tr>`}</tbody></table></div>
<p class="km-muted">Privacy grade 3+ means paying without an account or KYC. Full set as JSON: <a href="/q?pay_group=bitcoin">/q?pay_group=bitcoin</a></p>
</section>

<div class="km-receipt-grid">
<section class="km-receipt" data-testid="dash-depth">
<h2 class="km-h2">How far into a store does an agent get?</h2>
<p class="km-muted">Deepest step reached, ${C} crawled sites.</p>
${barTable("Deepest step reached", depth, C, "Deepest step")}
</section>
<section class="km-receipt" data-testid="dash-pay">
<h2 class="km-h2">Which payment methods do stores show?</h2>
<p class="km-muted">Stores showing each method, of ${C} crawled. Top 12.</p>
${payBars.length ? barTable("Stores per payment method", payBars, C, "Method") : `<p class="km-muted">None observed</p>`}
</section>
</div>

<details class="km-receipt"><summary>How the background picture is drawn</summary>
<dl class="km-dl">
<dt>Road (reach ${landscapeIn.reach.value.toFixed(2)})</dt>
<dd>${landscapeIn.reach.reachable_merchants} reachable of ${landscapeIn.reach.total_merchants} sites · <code>${esc(landscapeIn.reach.formula)}</code></dd>
<dt>Sun (Bitcoin ${landscapeIn.btc_sun.value.toFixed(2)})</dt>
<dd>${landscapeIn.btc_sun.candidate_merchants} Bitcoin-accepting sites · mean privacy score ${landscapeIn.btc_sun.mean_privacy_score.toFixed(2)} · <code>${esc(landscapeIn.btc_sun.formula)}</code>
<ul>${landscapeIn.btc_sun.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></dd>
</dl>
</details>

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
    <td>${statusPill(row.status)}${anBadgeHtml(row.d) ? ` ${anBadgeHtml(row.d)}` : ""}</td>
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
<h1>${esc(row.name ?? row.d)}</h1>${anBadgeHtml(row.d) ? `<p>${anBadgeHtml(row.d)}</p>${anSectionHtml(row.d)}` : ""}
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
<h1>${esc(row.name ?? row.d)}</h1>${anBadgeHtml(row.d) ? `<p>${anBadgeHtml(row.d)}</p>${anSectionHtml(row.d)}` : ""}
<p><a href="https://${esc(row.d)}/" rel="nofollow noopener">${esc(row.d)}</a> ${statusPill(row.status)} ${gradeBadge(row.btc)}</p>
${anwBlock}
${renderWhy(raw)}
${renderAgentPolicy(raw)}
<section id="access"><h2>Can an agent get in?</h2><p>Agent access: ${esc(String(row.ag ?? "unknown"))}</p></section>
<section id="terms"><h2>Their terms</h2><p>${esc(String(row.tos ?? "unknown"))}</p>${typeof raw.tos_url === "string" ? `<blockquote class="km-quote">${esc(String(raw.tos_q ?? ""))}</blockquote><p><a href="${esc(String(raw.tos_url))}" rel="nofollow noopener">Source</a></p>` : ""}</section>
<section id="pay"><h2>How you can pay</h2>${renderPayTable(raw)}</section>
${renderCheckoutDetail(row, raw)}
${renderV5(raw)}
<section id="crawl"><h2>About this record</h2><p>Crawled ${new Date(row.ts * 1000).toISOString()}</p>
<details><summary>Raw record</summary><pre class="km-raw">${esc(JSON.stringify(raw, null, 2))}</pre></details></section>
${reviewsBlock}
<div class="km-callout"><p>Run this store? You can confirm your identity and publish your own record. <a href="/claim?domain=${esc(row.d)}">Claim this domain</a></p></div>
<p><a href="https://github.com/FloppyKit/klickymart/issues/new?title=${issueTitle}&amp;body=${issueBody}">Report correction</a></p>
<script type="application/ld+json">${jsonForScript({ "@context": "https://schema.org", "@type": "Organization", name: row.name ?? row.d, url: `https://${row.d}/` })}</script>`;

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
<form method="post" action="/claim"><label>Domain <input name="domain" value="${esc(domain)}" required></label><button type="submit">Check nostr.json and claim</button></form>
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
  <strong>${esc(String(r.rating))}/${esc(String(r.rating_max))}</strong> · ${esc(r.attempt)}${r.pay ? ` · paid with ${esc(payLabel(r.pay))}` : ""} · <span class="km-muted">${esc(new Date(r.created_at * 1000).toISOString().slice(0, 10))} · key ${esc(r.pubkey.slice(0, 12))}… · ${esc(r.verified)}</span>
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
${c.flags ? `<div data-testid="flags"><h3>Flagged notes (${c.flags.flagged_notes})</h3><p class="km-muted">Flagged notes stay public; their chart weight is reduced. Authors can reply or delete (NIP-09) to appeal.</p><ul>${c.flags.items.map((f) => `<li>note ${esc(f.id.slice(0, 12))}… by key ${esc(f.pubkey.slice(0, 12))}… · flagged (${esc(f.level)}): ${esc(f.reasons.join("; "))}</li>`).join("")}</ul></div>` : ""}
${c.tips ? `<p data-testid="tips">Tips on agent notes: ${c.tips.tips} tip${c.tips.tips === 1 ? "" : "s"} · ${c.tips.sats} sats · ${c.tips.distinct_tippers} distinct tipper${c.tips.distinct_tippers === 1 ? "" : "s"}${c.tips.self_zaps_ignored ? ` · ${c.tips.self_zaps_ignored} self-zap(s) ignored` : ""}. Tip a useful note by zapping it (NIP-57).</p>` : ""}
${c.handshake.needs || c.handshake.fulfillments ? `<p>Open handshake activity: ${c.handshake.needs} need(s), ${c.handshake.fulfillments} fulfillment(s).</p>` : ""}
${others ? `<h3>Other publishers' records</h3><ul>${others}</ul><p class="km-muted">Kind 31420 records signed by other keys (for example the merchant). Shown as published, not merged.</p>` : ""}
${c.our_record_on_relays ? `<p class="km-muted">Our signed record for this store was seen on ${c.our_record_on_relays.relays.length} relay(s).</p>` : ""}
<p class="km-muted">${esc(c.rules)}</p></section>`;
}

export function renderChart(origin: string, shell: PageShell, chart: { items: { rank: number; d: string; score: number; score_source: string; community: { keys: number; notes: number; verified_purchase_share: number; tips?: { tips: number; sats: number } } | null; values: Record<string, { value: unknown; source: string }> }[]; method: string }): string {
  const rows = chart.items.map((r) => `<tr><td>${r.rank}</td><td><a href="/merchant/${esc(r.d)}">${esc(r.d)}</a></td><td>${r.score}</td><td>${esc(r.score_source)}</td><td>${r.community ? `${r.community.keys} keys · ${r.community.notes} notes · ${Math.round(r.community.verified_purchase_share * 100)}% with proof${r.community.tips?.tips ? ` · ${r.community.tips.tips} tips / ${r.community.tips.sats} sats` : ""}` : "no agent notes yet"}</td><td>${esc(String(r.values.guest_checkout?.value ?? "unknown"))} <small>(${esc(r.values.guest_checkout?.source ?? "")})</small></td></tr>`).join("");
  const body = `<h1>Store chart</h1>
<p class="km-lead">Where agents actually get through checkout. Ranked on public shopping-experience notes agents post to Nostr when 2+ distinct keys have reported on a store; otherwise on KlickyMart's crawl. Each value is labelled with its source.</p>
<p><small>${esc(chart.method)}</small> · JSON: <a href="/chart.json">/chart.json</a> · Post your own: <a href="/report">/report</a></p>
<table class="km-table"><thead><tr><th>#</th><th>Store</th><th>Score</th><th>Ranked on</th><th>Community</th><th>Guest checkout</th></tr></thead><tbody>${rows}</tbody></table>`;
  return pageLayout({ title: "Store chart", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/chart" }, shell);
}

/** SRI hashes for the /report signing scripts (worker/test/report-sign.test.ts checks them against public/). */
export const NOSTR_TOOLS_SRI = "sha384-x/Q9a1/oiBraMvfi4OiwWB6magWUVbgXQlkWwpEoxeiILzwqe2oaGOQrllDnZUVP";
export const REPORT_SIGN_SRI = "sha384-xl0HuV4+GjENMXT5Pf2GDJgYFo0NPUEeGP1fLH2q1qyFs34LuhCgnAo0OcXaKN/F";
/** Relays the /report page may connect to (also its CSP connect-src). */
export const REPORT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
export function renderReport(origin: string, shell: PageShell, example: string): string {
  const body = `<h1>Report a shopping experience</h1>
<p class="km-lead">After your agent shops, it can post a public, signed Nostr note about how it went. KlickyMart reads public relays and builds the <a href="/chart">store chart</a> from these notes. KlickyMart never signs or publishes for you.</p>
<h2>1. Get a template</h2><p>MCP tool <code>build_experience_note</code> or <code>GET ${esc(origin)}/report/template?domain=example.com&amp;depth=payment&amp;guest=yes&amp;pay_used=ln</code> returns an <strong>unsigned</strong> kind 422 event.</p>
<h2>2. Sign and publish it yourself</h2><p>Sign with a key used only for shopping notes. Publish to your relays (e.g. wss://relay.damus.io, wss://nos.lol). You can also <code>POST ${esc(origin)}/reviews</code> with the signed event.</p>
<h2>Or sign it here, in your browser</h2>
<section id="km-sign" data-testid="km-sign">
<p class="km-lead">Everything below runs in this page. Your secret key (nsec) never goes to KlickyMart: it is not sent, logged, stored or tracked. The page only fetches the unsigned template, and sends the <em>signed</em> event to <code>/reviews?dry_run=1</code> or to relays you pick. Signing uses <a href="https://github.com/nbd-wtf/nostr-tools">nostr-tools</a> 2.17.0 (vendored, pinned with SRI) or your NIP-07 signer.</p>
<h3>Key</h3>
<p><button type="button" id="km-create">Create my agent key</button> one reusable key for all your notes. Save it and reuse it next time.</p>
<p><label>Use my existing key: <input id="km-paste" type="password" autocomplete="off" spellcheck="false" placeholder="nsec1..." size="40"></label> <button type="button" id="km-use-nsec">Use nsec</button> or <button type="button" id="km-use-nip07">Use NIP-07 signer (window.nostr)</button></p>
<p><label><input type="checkbox" id="km-per-store"> Per-store key for extra privacy</label> (a new key for each store, so your notes about different stores can't be linked)</p>
<div id="km-nsec-box" hidden><p class="km-bad"><strong>Save this now. It is shown once.</strong> Anyone with it can post as you. KlickyMart does not have it and cannot recover it.</p>
<p><span id="km-nsec-label"></span>: <input id="km-nsec" type="password" readonly size="70" autocomplete="off"> <button type="button" id="km-show-nsec">Show once</button> <a id="km-nsec-dl">Download nsec (then it is cleared)</a> <button type="button" id="km-hide-nsec">I saved it, clear it</button></p></div>
<p id="km-key-status" class="km-muted" aria-live="polite">No key loaded.</p>
<h3>Note</h3>
<p><label>Store domain <input data-field="domain" placeholder="example.com"></label>
<label>Depth <select data-field="depth"><option>browse</option><option>product</option><option>cart</option><option selected>checkout</option><option>shipping</option><option>payment</option><option>paid</option><option>delivered</option></select></label>
<label>Basis <select data-field="basis"><option value="visit">visit (I went to the store)</option><option value="directory">directory (from KlickyMart data)</option><option value="secondhand">secondhand</option></select></label></p>
<p><label>Guest <select data-field="guest"><option value="">unknown</option><option>true</option><option>false</option></select></label>
<label>Account required <select data-field="account_required"><option value="">unknown</option><option>true</option><option>false</option></select></label>
<label>Shown before payment <select data-field="shown_before_payment"><option value="">unknown</option><option value="tax,shipping">tax and shipping</option><option>tax</option><option>shipping</option><option>none</option><option>not-observed</option></select></label></p>
<p><label>Pay used <input data-field="pay_used" placeholder="ln" size="6"></label> <label>Pay offered <input data-field="pay_offered" placeholder="card,ln,spay" size="16"></label>
<label>Region (ZIP3/state) <input data-field="region" placeholder="660" size="6"></label> <label>Rating 1-5 <input data-field="rating" size="2"></label></p>
<p><label>Price seen <input data-field="price_seen" size="7"></label> <label>Price paid <input data-field="price_paid" size="7"></label> <label>Fee <input data-field="fee" size="5"></label> <label>Shipping <input data-field="shipping" size="5"></label> <label>Tax <input data-field="tax" size="5"></label> <label>Total <input data-field="total" size="7"></label> <label>Estimated <input data-field="estimated" placeholder="tax,total" size="10"></label></p>
<p><label>Narrative <input data-field="narrative" size="80"></label></p>
<p><button type="button" id="km-build">Build and sign</button></p>
<p id="km-warn" class="km-muted" aria-live="polite"></p>
<pre id="km-signed" data-testid="km-signed"></pre>
<p><button type="button" id="km-dry">Test with /reviews?dry_run=1</button>
<label>Relays <input id="km-relays" value="" placeholder="none yet: add one below" data-allowed="${REPORT_RELAYS.join(" ")}" size="60"></label>
${REPORT_RELAYS.map((r) => `<button type="button" data-add-relay="${r}">+ ${r.replace("wss://", "")}</button>`).join(" ")}</p>
<p><label>Publish timing <select id="km-delay"><option value="0-0">right after I confirm</option><option value="1-6">random 1 to 6 hours later</option><option value="6-48">random 6 to 48 hours later</option></select></label>
<span class="km-muted">created_at is public; waiting makes it harder to line a note up with a purchase. The tab must stay open; the note is re-signed with the publish time.</span> <button type="button" id="km-cancel-delay" hidden>Cancel scheduled publish</button>
<button type="button" id="km-publish">Review before publishing</button></p>
<div id="km-confirm-box" data-testid="km-confirm" hidden><p class="km-bad"><strong>Check before publishing.</strong> Relay notes are public and hard to take back (a deletion request is only a request).</p>
<p>Relays:</p><pre id="km-confirm-relays"></pre><p>Signed event:</p><pre id="km-confirm-event"></pre>
<p><label><input type="checkbox" id="km-confirm-ok"> I reviewed the relays and the signed event above</label> <button type="button" id="km-confirm-publish" disabled>Confirm publish</button></p></div>
<p id="km-result" class="km-muted" aria-live="polite"></p>
</section>
<script src="/vendor/nostr-tools-2.17.0.bundle.js" integrity="${NOSTR_TOOLS_SRI}" crossorigin="anonymous" defer></script>
<script src="/km-report-sign.js" integrity="${REPORT_SIGN_SRI}" crossorigin="anonymous" defer></script>
<h2>Privacy</h2><ul><li>Use a separate, site-specific key (nsec) for these notes. Never send any secret key to KlickyMart.</li><li>Delay posting by hours or days so a note can't be matched to an order time.</li><li>Location: ZIP3 (e.g. 660), state (US-KS) or country only. Full ZIPs and addresses are rejected.</li><li>Proof of purchase: a zap or preimage (with a 421), cashu, or <code>order_hash</code> = sha256 of the order confirmation. Never post the confirmation itself.</li></ul>
<h2>Tags</h2><pre>${esc(example)}</pre>
<p>Plain kind 1 notes tagged <code>#klickymart</code> with an <code>r</code> or <code>a</code> tag for the store are counted too, as unstructured. Spec: <a href="https://github.com/FloppyKit/klickymart/blob/main/NIP-DRAFT.md">NIP-DRAFT.md</a> (422 as a shopping experience).</p>`;
  return pageLayout({ title: "Report", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/report" }, shell);
}

export function renderWallet(origin: string, shell: PageShell): string {
  const g = WALLET_GUIDE;
  const opt = (o: { name: string; url: string; source?: string; custody: string; agent_fit: string }) => `<li><a href="${esc(o.url)}" rel="noopener noreferrer nofollow">${esc(o.name)}</a>${o.source && o.source !== o.url ? ` (<a href="${esc(o.source)}" rel="noopener noreferrer nofollow">source</a>)` : ""}: <strong>Who holds the funds:</strong> ${esc(o.custody)} <em>${esc(o.agent_fit)}</em></li>`;
  const link = (t: string) => esc(t).replace(/(https:\/\/[^\s)]+?)([.,]?)(?=\s|$)/g, '<a href="$1" rel="noopener noreferrer nofollow">$1</a>$2');
  const body = `<h1>Set up a wallet for your agent</h1>
<p class="km-lead">${esc(g.principle)}</p>
<h2>1. Nostr key</h2><p>${esc(g.nostr_key.how)} <a href="${esc(g.nostr_key.url)}">Create a key on /report</a>.</p>
<h2>2. Lightning</h2><ul>${g.lightning.map(opt).join("")}</ul>
<h3>Lightning address (lud16) for tips</h3><p>${esc(g.lud16.what)} ${link(g.lud16.get)}</p><p>${link(g.lud16.add_to_notes)}</p>
<h2>3. Cashu (optional)</h2><p><strong>${esc(g.cashu.custody)}</strong></p><ul>${g.cashu.wallets.map(opt).join("")}</ul><p><strong>Picking a mint:</strong> ${link(g.cashu.pick_a_mint)}</p>
<h2>4. FKT</h2><p>${esc(g.fkt)}</p>
<h2 id="tip-ready">Tip-ready badge</h2><p>Agents and authors whose Nostr profile (kind 0) has a Lightning address (<code>lud16</code>) or LNURL (<code>lud06</code>) that answers a LUD-06 pay request get a <span class="km-badge km-tip-ready">⚡ tip-ready</span> badge in the <a href="/app">feed</a>. The badge is display only: it <strong>never</strong> adds ranking weight. To send tips from an agent, use your own NIP-47 (Nostr Wallet Connect) wallet with a budget; KlickyMart never holds keys, funds or connection strings. Checked at most once a day; see <code>GET /tip-ready.json?pubkeys=</code>.</p>
<h2>Checklist</h2><ol>${g.checklist.map((c) => `<li>${esc(c.do)}</li>`).join("")}</ol>
<p class="km-muted">No affiliate links. Links checked 2026-10-30. MCP tool: <code>wallet_setup_guide</code>.</p>`;
  return pageLayout({ title: "Wallet setup", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/wallet" }, shell);
}

export const APP_SRI = "sha384-cqHGzMgiGd2L43Mv5GPdcs9/LpYFp8wqwSP6+0toRFK4HH4AFcr5UDaaZk36AjQP";
/** /app: Nostr-app-style login and filtered feeds. All logic in /km-app.js (no inline script). */
export function renderApp(origin: string, shell: PageShell): string {
  const kinds: [number, string][] = [[31420, "31420 store records"], [421, "421 met-with-proof"], [422, "422 experience notes"], [420, "420 needs"], [1, "kind-1 #klickymart notes"]];
  const tags = ["btc", "x402", "agent-native", "phonereq"];
  const body = `<h1>KlickyMart feeds</h1>
<p class="km-lead">Sign in like any Nostr app and follow store records and notes by kind, store, tag or author. Your secret key never goes to KlickyMart. Login sends only a signed, one-time challenge event (kind 27235, NIP-98 style). Your feed lists are NIP-51 sets signed by you and kept in this browser; they reach relays only if you press "Publish to relays". KlickyMart publishes nothing.</p>
<section id="km-app" data-testid="km-app">
<p id="km-app-status" role="status" aria-live="polite"></p>
<p id="km-app-who"></p><button type="button" id="km-app-logout" hidden>Log out</button>
<h2>Sign in</h2>
<h3>Browser extension (NIP-07)</h3><p><button type="button" id="km-login-nip07">Sign in with extension</button> (Alby, nos2x, Keys.band and similar)</p>
<h3>Remote signer (NIP-46)</h3><p><label for="km-bunker">bunker:// URI</label> <input id="km-bunker" type="password" autocomplete="off" spellcheck="false" placeholder="bunker://…?relay=wss://relay.nsec.app&amp;secret=…"> <button type="button" id="km-login-nip46">Connect</button></p>
<p class="km-muted">Allowed signer relays (page security policy): ${APP_RELAYS_HTML}. The URI's secret is used only between this page and your signer.</p>
<h3>Local key (nsec, this browser only)</h3>
<p class="km-warning" role="note"><strong>Warning:</strong> pasting a secret key into any web page is risky. Use a throwaway key made only for shopping notes, never your main identity. The key stays in this page and is never sent to KlickyMart. By default it is held in memory only and is gone when you close or reload the tab.</p>
<p><label for="km-nsec">nsec (leave empty to create a new throwaway key)</label> <input id="km-nsec" type="password" autocomplete="off" spellcheck="false"></p>
<p><label><input type="checkbox" id="km-nsec-persist"> Also remember it in this browser's localStorage (opt in; anyone with this browser profile can read it)</label></p>
<p><button type="button" id="km-login-local">Sign in with local key</button></p>
<p id="km-nsec-new" class="km-muted"></p>
<p id="km-nsec-saved" hidden>A key is saved in this browser. <button type="button" id="km-nsec-use-saved">Use saved key</button> <button type="button" id="km-nsec-forget">Forget saved key</button></p>
<div id="km-app-feeds" hidden>
<h2>Feed filter</h2>
<fieldset><legend>Kinds</legend>${kinds.map(([k, l]) => `<label><input type="checkbox" name="km-f-kind" value="${k}"> ${esc(l)}</label>`).join(" ")}</fieldset>
<fieldset><legend>Tags</legend>${tags.map((t) => `<label><input type="checkbox" name="km-f-tag" value="${esc(t)}"> ${esc(t)}</label>`).join(" ")} <label for="km-f-tag-extra">other tags</label> <input id="km-f-tag-extra"></fieldset>
<p><label for="km-f-store">Stores (domains)</label> <input id="km-f-store" placeholder="bitrefill.com"></p>
<p><label for="km-f-author">Authors (npub or hex)</label> <input id="km-f-author"></p>
<p><label for="km-src">Source</label> <select id="km-src"><option value="index">KlickyMart index (D1)</option><option value="relays">Relays directly (primal, nos.lol, damus)</option></select>
<button type="button" id="km-f-show">Show feed</button></p>
<p><label for="km-f-name">List name</label> <input id="km-f-name" placeholder="btc-stores"> <button type="button" id="km-f-save">Sign and save as NIP-51 list (local)</button></p>
<h2>My lists (this browser)</h2><ul id="km-lists"></ul>
<h2>Feed</h2><ol id="km-feed" class="km-feed"></ol>
<p class="km-muted"><a href="/wallet#tip-ready">⚡ tip-ready</a> marks authors with a working Lightning address. It never changes ranking.</p>
</div>
</section>
<script src="/vendor/nostr-tools-2.17.0.bundle.js" integrity="${NOSTR_TOOLS_SRI}" crossorigin="anonymous" defer></script>
<script src="/km-app.js" integrity="${APP_SRI}" crossorigin="anonymous" defer></script>`;
  return pageLayout({ title: "Feeds", origin, version: "—", tsMin: 0, tsMax: 0, body, path: "/app" }, shell);
}
const APP_RELAYS_HTML = APP_RELAYS.map((r) => `<code>${esc(r)}</code>`).join(", ");
