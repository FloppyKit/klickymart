/** Live agent visits: daily aggregates by coarse agent family. Stores no IPs, no full UAs, nothing personal. */
export const COUNTED_PATHS = ["/mcp", "/q", "/check", "/llms.txt", "/export.ndjson"] as const;
export type CountedPath = (typeof COUNTED_PATHS)[number];
export const AGENT_FAMILIES = ["claude", "openai", "cursor", "gemini", "perplexity", "curl", "python", "node", "go", "browser", "other"] as const;
export type AgentFamily = (typeof AGENT_FAMILIES)[number];

/** Simulated shoppers shown on the landscape until real traffic exists. */
export const SIMULATED_SHOPPER_FLOOR = 2;
export const MAX_SHOPPERS = 8;
/** Agent requests per walking shopper. */
export const VISITS_PER_SHOPPER = 5;

const RULES: [AgentFamily, RegExp][] = [
  ["claude", /claude|anthropic/i],
  ["openai", /openai|chatgpt|gptbot|oai-searchbot/i],
  ["cursor", /cursor/i],
  ["gemini", /gemini|google-extended|googleother/i],
  ["perplexity", /perplexity/i],
  ["curl", /^curl\/|\bwget\//i],
  ["python", /python|aiohttp|httpx/i],
  ["node", /node|undici|axios|node-fetch/i],
  ["go", /go-http-client/i],
  ["browser", /mozilla\/5\.0/i],
];

export function agentFamily(ua: string | null | undefined): AgentFamily {
  const s = (ua ?? "").slice(0, 512);
  if (!s) return "other";
  for (const [fam, rx] of RULES) if (rx.test(s)) return fam;
  return "other";
}

export function countedPath(path: string): CountedPath | null {
  return (COUNTED_PATHS as readonly string[]).includes(path) ? (path as CountedPath) : null;
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function recordAgentVisit(db: D1Database | undefined, path: string, ua: string | null, now = Date.now()): Promise<void> {
  const p = countedPath(path);
  if (!db || !p) return;
  try {
    await db.prepare(
      "INSERT INTO agent_visits (day, family, path, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, family, path) DO UPDATE SET n = n + 1",
    ).bind(utcDay(now), agentFamily(ua), p).run();
  } catch {
    /* table missing (migration pending): never fail the request over a counter */
  }
}

export interface AgentStats {
  day: string;
  total_today: number;
  by_family: Record<string, number>;
  by_path: Record<string, number>;
  last_7_days: { day: string; n: number }[];
  shoppers: { real: number; simulated: number; total: number; visits_per_shopper: number; simulated_floor: number };
  privacy: string;
}

export function shopperSplit(visitsToday: number): { real: number; simulated: number; total: number } {
  const real = Math.min(MAX_SHOPPERS, Math.ceil(Math.max(0, visitsToday) / VISITS_PER_SHOPPER));
  const total = Math.min(MAX_SHOPPERS, Math.max(real, SIMULATED_SHOPPER_FLOOR));
  return { real, simulated: total - real, total };
}

export async function visitsToday(db: D1Database | undefined, now = Date.now()): Promise<number> {
  if (!db) return 0;
  try {
    const r = await db.prepare("SELECT COALESCE(SUM(n),0) AS n FROM agent_visits WHERE day = ?").bind(utcDay(now)).first<{ n: number }>();
    return Number(r?.n ?? 0);
  } catch {
    return 0;
  }
}

export async function agentStats(db: D1Database | undefined, now = Date.now()): Promise<AgentStats> {
  const day = utcDay(now);
  const by_family: Record<string, number> = {};
  const by_path: Record<string, number> = {};
  let total = 0;
  const last: { day: string; n: number }[] = [];
  if (db) {
    try {
      const { results } = await db.prepare("SELECT family, path, n FROM agent_visits WHERE day = ?").bind(day).all<{ family: string; path: string; n: number }>();
      for (const r of results ?? []) {
        by_family[r.family] = (by_family[r.family] ?? 0) + r.n;
        by_path[r.path] = (by_path[r.path] ?? 0) + r.n;
        total += r.n;
      }
      const since = utcDay(now - 6 * 86400_000);
      const w = await db.prepare("SELECT day, SUM(n) AS n FROM agent_visits WHERE day >= ? GROUP BY day ORDER BY day").bind(since).all<{ day: string; n: number }>();
      for (const r of w.results ?? []) last.push({ day: r.day, n: Number(r.n) });
    } catch {
      /* migration pending */
    }
  }
  return {
    day,
    total_today: total,
    by_family,
    by_path,
    last_7_days: last,
    shoppers: { ...shopperSplit(total), visits_per_shopper: VISITS_PER_SHOPPER, simulated_floor: SIMULATED_SHOPPER_FLOOR },
    privacy: "Daily counts per coarse agent family and endpoint only. No IP addresses, no full user agents, nothing personal is stored.",
  };
}
