import type { IndexRow, Snapshot } from "./index-mem";
import { parseRaw } from "./records-api";

/** Agent-reachable share among all indexed merchants (0–1). */
export function computeReachShare(rows: IndexRow[]): number {
  if (!rows.length) return 0;
  const reachable = rows.filter((r) => r.status === "crawled" && r.ag !== null && r.ag >= 1).length;
  return reachable / rows.length;
}

const PRIV_PAY = new Set(["ln", "lnurl", "bolt12", "cashu", "fedi", "sp", "ark"]);

/** Per-row private-Bitcoin signal 0–1 from grade + payment methods + btcpriv hints. */
export function rowBtcPrivacyScore(row: IndexRow): number {
  let score = 0;
  if (row.btc !== null && row.btc >= 0) {
    score += row.btc / 4;
  } else if (row.btc_any === 1) {
    score += 0.15;
  }

  const raw = parseRaw(row.raw_json);
  const pays = [
    ...(Array.isArray(raw.pay) ? raw.pay : []),
    ...(Array.isArray(raw.pay_online) ? raw.pay_online : []),
  ].filter((x): x is string => typeof x === "string");

  for (const p of pays) {
    if (PRIV_PAY.has(p)) score += 0.12;
    if (p === "btc") score += 0.04;
  }

  const btcpriv = raw.btcpriv;
  if (Array.isArray(btcpriv)) {
    for (const tag of btcpriv) {
      if (typeof tag !== "string") continue;
      if (tag === "ecash" || tag === "selfhosted" || tag === "noacct" || tag === "nokyc") score += 0.08;
      if (tag === "sp" || tag === "ark") score += 0.06;
    }
  }

  return Math.min(1, score);
}

/** Mean private-Bitcoin score across merchants that accept any BTC (0–1). */
export function computeBtcSunScore(rows: IndexRow[]): number {
  const candidates = rows.filter(
    (r) => (r.btc !== null && r.btc > 0) || r.btc_any === 1 || (r.pay_any & (1 << 14)) !== 0,
  );
  if (!candidates.length) return 0;
  const sum = candidates.reduce((a, r) => a + rowBtcPrivacyScore(r), 0);
  return sum / candidates.length;
}

export function landscapeFromSnapshot(snap: Snapshot): { reach: number; btc: number } {
  return {
    reach: computeReachShare(snap.rows),
    btc: computeBtcSunScore(snap.rows),
  };
}

export interface LandscapeFormulaInputs {
  reach: {
    reachable_merchants: number;
    total_merchants: number;
    formula: string;
    value: number;
  };
  btc_sun: {
    candidate_merchants: number;
    mean_privacy_score: number;
    formula: string;
    value: number;
    notes: string[];
  };
}

export function landscapeFormulaInputs(rows: IndexRow[]): LandscapeFormulaInputs {
  const total = rows.length;
  const reachable = rows.filter((r) => r.status === "crawled" && r.ag !== null && r.ag >= 1).length;
  const reachValue = total ? reachable / total : 0;

  const candidates = rows.filter(
    (r) => (r.btc !== null && r.btc > 0) || r.btc_any === 1 || (r.pay_any & (1 << 14)) !== 0,
  );
  const scores = candidates.map((r) => rowBtcPrivacyScore(r));
  const meanScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return {
    reach: {
      reachable_merchants: reachable,
      total_merchants: total,
      formula: "count(status=crawled ∧ ag≥1) / count(all)",
      value: reachValue,
    },
    btc_sun: {
      candidate_merchants: candidates.length,
      mean_privacy_score: meanScore,
      formula: "mean(rowBtcPrivacyScore) over BTC-accepting merchants",
      value: meanScore,
      notes: [
        "row score blends btc grade/4, btc_any (+0.15), Lightning/ecash pay methods (+0.12), on-chain (+0.04), btcpriv tags (+0.06–0.08), capped at 1",
      ],
    },
  };
}

export function reachToLandscapeFidelity(reach: number): number {
  return Math.max(0, Math.min(3, reach * 3));
}

export function parseLandscapeOverride(
  reachRaw: string | null,
  btcRaw: string | null,
  tierRaw: string | null = null,
): { reach?: number; btc?: number; tier?: number } {
  const out: { reach?: number; btc?: number; tier?: number } = {};
  if (reachRaw !== null && reachRaw !== "") {
    const n = Number(reachRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) out.reach = n;
  }
  if (btcRaw !== null && btcRaw !== "") {
    const n = Number(btcRaw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) out.btc = n;
  }
  if (tierRaw !== null && tierRaw !== "") {
    const t = parseInt(tierRaw, 10);
    if (!Number.isNaN(t) && t >= 0 && t <= 3) out.tier = t;
  }
  return out;
}

/** A store "takes Bitcoin privately" when its BTC grade is 3 or 4. */
export const PRIVATE_BTC_MIN_GRADE = 3;

export interface StoryCounts {
  total: number;
  reachable: number;
  private_btc: number;
  private_btc_reachable: number;
}

/** Live counts for the home story line and the agent shoppers on the road. */
export function computeStoryCounts(rows: IndexRow[]): StoryCounts {
  let reachable = 0;
  let privateBtc = 0;
  let privateBtcReachable = 0;
  for (const r of rows) {
    const isReach = r.status === "crawled" && r.ag !== null && r.ag >= 1;
    const isPriv = r.btc !== null && r.btc >= PRIVATE_BTC_MIN_GRADE;
    if (isReach) reachable++;
    if (isPriv) privateBtc++;
    if (isReach && isPriv) privateBtcReachable++;
  }
  return { total: rows.length, reachable, private_btc: privateBtc, private_btc_reachable: privateBtcReachable };
}

/** One shopper per 20 reachable stores, capped at 8. */
export function agentShopperCount(reachable: number): number {
  return Math.max(0, Math.min(8, Math.round(reachable / 20)));
}

export function storyLine(c: StoryCounts): string {
  const stores = (n: number) => (n === 1 ? "store" : "stores");
  const letIn = c.reachable === 1 ? "lets" : "let";
  const take = c.private_btc === 1 ? "takes" : "take";
  return `${c.reachable} of ${c.total} ${stores(c.total)} ${letIn} agents in. ${c.private_btc} ${take} Bitcoin privately. Watch the sun rise.`;
}
