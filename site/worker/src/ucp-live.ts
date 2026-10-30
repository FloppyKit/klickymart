/** Live (never cached or stored) read-only search of Shopify's Global Catalog over UCP MCP, identified by our UCP agent profile.
 * Shopify usage guidelines: no caching of results, no re-use of images (we drop image URLs). Attribution: "Results from Shopify Catalog". */
export const GLOBAL_CATALOG = "https://catalog.shopify.com/api/ucp/mcp";
const strip = (o: unknown): unknown => {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!/image|media|thumbnail/i.test(k)) out[k] = strip(v);
    return out;
  }
  return o;
};
export async function liveCatalogSearch(query: string, zip: string | null, origin: string, fetcher: typeof fetch = fetch) {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: {
    meta: { "ucp-agent": { profile: `${origin}/.well-known/ucp` } },
    catalog: { query, context: { address_country: "US", ...(zip ? { postal_code: zip } : {}), currency: "USD" }, filters: { available: true } } } } };
  try {
    const r = await fetcher(GLOBAL_CATALOG, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "User-Agent": "FloppyKitMapBot/0.2 Agent/KlickyBot (+https://klickymart.com/bot)" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { result?: { structuredContent?: unknown; content?: { text?: string }[] }; error?: { message: string; data?: unknown } };
    if (j.error) return { ok: false, source: "Shopify Catalog (live)", error: j.error.message, detail: j.error.data ?? null };
    let sc = j.result?.structuredContent;
    if (!sc && j.result?.content?.[0]?.text) { try { sc = JSON.parse(j.result.content[0].text); } catch { sc = j.result.content[0].text; } }
    return { ok: true, source: "Results from Shopify Catalog (live, not cached or stored by KlickyMart; prices in minor units)", results: strip(sc) };
  } catch (e) {
    return { ok: false, source: "Shopify Catalog (live)", error: String(e).slice(0, 120) };
  }
}
