import { describe, expect, it, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { ingestFromNdjsonText } from "../src/ingest";
import { rowsToSnapshot, type Snapshot } from "../src/index-mem";
import { anOf, clearAgentNative, mergeAgentNative, anJson, anCount } from "../src/agent-native";
import { querySnapshot, validateQueryParams } from "../src/query";
import { findAlternatives, resolveCategory } from "../src/alternatives";
import { rowToCompact } from "../src/records-api";
import { mcpToolsList } from "../src/mcp";
import REAL from "../../../data/events.ndjson?raw";
import AN from "../../../data/events.agent-native.ndjson?raw";

let snap: Snapshot;
let mainSig: string | null = null;
beforeAll(async () => {
  const main = await ingestFromNdjsonText(REAL as string, { allowSynthetic: false, verifyEvents: false, sourceLabel: "t" });
  mainSig = main.rows.get("bitrefill.com")?.raw_json ?? null;
  const an = await ingestFromNdjsonText(AN as string, { allowSynthetic: false, verifyEvents: true, sourceLabel: "t-an" });
  expect(an.rows.size).toBe(185);
  clearAgentNative();
  const r = mergeAgentNative(main.rows, an.rows);
  expect(r).toEqual({ added: 176, overlaid: 9 });
  snap = rowsToSnapshot([...main.rows.values()], main.report.version, main.report.source);
});
const q = (s: string) => { const v = validateQueryParams(new URLSearchParams(s)); if (!v.ok) throw new Error(v.message); return querySnapshot(snap, v.params); };

describe("agent-native stores (2026-10-30)", () => {
  it("adds 176 new signed rows and overlays 9 existing domains without replacing their signed main record", () => {
    expect(snap.rows.length).toBe(363 + 176);
    expect(anCount()).toBe(185);
    const b = snap.rows.find((r) => r.d === "bitrefill.com")!;
    expect(b.raw_json).toBe(mainSig);
    expect(JSON.parse(b.raw_json).agent_native).toBeUndefined();
    expect(anOf("bitrefill.com")?.label).toBe("verified-402");
  });
  it("/q agent_native=1 returns all 185, including findings with their status", () => {
    const r = q("agent_native=1&limit=500");
    expect(r.total).toBe(185);
    const st = new Set(r.items.map((i) => i.status));
    for (const s of ["crawled", "blocked-tos", "agents-not-welcome", "error"]) expect(st.has(s as never)).toBe(true);
    expect(q("agent_native=0&limit=500").total).toBe(363 - 9);
  });
  it("rail_status=verified-402 lists only stores whose 402 we saw, with price_seen; claimed ones stay claimed", () => {
    const v = q("rail_status=verified-402&limit=500");
    expect(v.total).toBe(21);
    for (const row of v.items) {
      const a = anJson(row.d)! as { label: string; probe_402: { result: string; http: number; price_seen: { amount: string; asset: string } } };
      expect(a.label).toBe("verified-402");
      expect(a.probe_402.http).toBe(402);
      expect(String(a.probe_402.price_seen.amount)).toMatch(/^\d+(\.\d+)?$/);
    }
    expect(anOf("stableenrich.dev")?.an_rails_v.x402).toBe("no-402");
    expect(anOf("stableenrich.dev")?.label).toBe("claimed");
    expect(anOf("satsdns.com")?.an_402?.proto).toBe("l402");
    expect(anOf("satsdns.com")?.an_rails_v.l402).toBe("verified-402");
    expect(anOf("sats4ai.com")?.an_rails_v.l402).toBe("no-402");
  });
  it("an_cat filter accepts alt names (paid-api = l402 + x402) and rejects junk", () => {
    expect(q("an_cat=paid-api&limit=500").total).toBe(q("an_cat=l402&limit=500").total + q("an_cat=x402&limit=500").total);
    expect(validateQueryParams(new URLSearchParams("an_cat=nope")).ok).toBe(false);
    expect(validateQueryParams(new URLSearchParams("agent_native=2")).ok).toBe(false);
    expect(validateQueryParams(new URLSearchParams("rail_status=paid")).ok).toBe(false);
  });
  it("/alternatives supports vps, vpn, esim, paid-api, gift-cards; refusing stores only as turned_away", () => {
    for (const c of ["vps", "vpn", "esim", "paid-api"]) {
      expect(resolveCategory(c)).toBe(c);
      const r = findAlternatives(snap, "https://klickymart.com", { category: c, limit: 50 });
      if (!r.ok) throw new Error(r.message);
      const body = r.body as { items: { d: string; agent_native?: unknown }[]; turned_away: { status: string }[] };
      expect(body.items.length).toBeGreaterThan(0);
      for (const i of body.items) expect(i.agent_native).toBeTruthy();
      for (const t of body.turned_away) expect(t.status).not.toBe("crawled");
    }
    const g = findAlternatives(snap, "https://klickymart.com", { category: "gift-cards", limit: 50 });
    if (!g.ok) throw new Error(g.message);
    expect((g.body as { items: { agent_native?: unknown }[] }).items.some((i) => i.agent_native)).toBe(true);
  });
  it("compact rows carry agent_native only for agent-native stores", () => {
    const an = rowToCompact(snap.rows.find((r) => r.d === "tariffmonkee.com")!, "https://x");
    expect((an.agent_native as { label: string }).label).toBe("verified-402");
    expect(rowToCompact(snap.rows.find((r) => r.d === "amazon.com")!, "https://x").agent_native).toBeUndefined();
  });
  it("MCP exposes find_agent_native and the new search_merchants filters", () => {
    const tools = (mcpToolsList() as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
    expect(tools.some((t) => t.name === "find_agent_native")).toBe(true);
    const sm = tools.find((t) => t.name === "search_merchants")!;
    expect(Object.keys(sm.inputSchema.properties)).toEqual(expect.arrayContaining(["agent_native", "an_cat", "rail_status"]));
  });
  it("HTTP: /q validates agent_native, llms.txt and openapi document it", async () => {
    expect((await SELF.fetch("https://example.com/q?agent_native=1")).status).toBe(200);
    expect((await SELF.fetch("https://example.com/q?agent_native=yes")).status).toBe(400);
    const llms = await (await SELF.fetch("https://example.com/llms.txt")).text();
    expect(llms).toContain("agent_native=1");
    expect(llms).toContain("verified-402");
    const oa = await (await SELF.fetch("https://example.com/openapi.json")).text();
    expect(oa).toContain("rail_status");
  });
});
