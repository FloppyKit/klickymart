import {
  AR_CODES,
  CAT_CODES,
  PAY_CODES,
  PAY_GROUPS,
  STATUS_VALUES,
  payCodeToBit,
  arCodeToBit,
  catCodeToBit,
} from "./codes";
import type { IndexRow, Snapshot } from "./index-mem";

export interface QueryParams {
  q?: string;
  status?: string[];
  reachable?: boolean;
  btc?: number | null;
  btc_min?: number;
  btc_any?: boolean;
  pay?: string[];
  pay_all?: string[];
  pay_group?: string;
  scope?: "online" | "instore" | "unscoped" | "any";
  no_ar?: string[];
  ar?: string[];
  ag_min?: number;
  co_min?: number;
  ease_min?: number;
  guest?: number;
  tos?: string;
  kyc?: string;
  cat?: string[];
  sort?: string[];
  limit?: number;
  cursor?: string;
}

export interface QueryResult {
  total: number;
  count: number;
  next: string | null;
  items: IndexRow[];
  filter_ms: number;
}

const DEFAULT_SORT = ["-btc", "-ag", "d"];
const KNOWN_PARAMS = new Set([
  "q", "status", "reachable", "btc", "btc_min", "btc_any", "pay", "pay_all", "pay_group",
  "scope", "no_ar", "ar", "ag_min", "co_min", "ease_min", "guest", "tos", "kyc", "cat",
  "sort", "limit", "cursor", "fields", "format",
]);

export function validateQueryParams(searchParams: URLSearchParams): { ok: true; params: QueryParams } | { ok: false; param: string; message: string } {
  for (const key of searchParams.keys()) {
    if (!KNOWN_PARAMS.has(key)) {
      return { ok: false, param: key, message: `unknown parameter: ${key}` };
    }
  }

  const params: QueryParams = {};

  const q = searchParams.get("q");
  if (q) params.q = q.toLowerCase();

  const status = searchParams.get("status");
  if (status) {
    const parts = status.split(",").map((s) => s.trim());
    for (const s of parts) {
      if (!STATUS_VALUES.includes(s as (typeof STATUS_VALUES)[number])) {
        return { ok: false, param: "status", message: `invalid status: ${s}` };
      }
    }
    params.status = parts;
  }

  const reachable = searchParams.get("reachable");
  if (reachable !== null) {
    if (reachable !== "1" && reachable !== "0") {
      return { ok: false, param: "reachable", message: "reachable must be 0 or 1" };
    }
    params.reachable = reachable === "1";
  }

  const btc = searchParams.get("btc");
  if (btc !== null) {
    if (btc === "null") params.btc = null;
    else {
      const n = parseInt(btc, 10);
      if (Number.isNaN(n) || n < 0 || n > 4) {
        return { ok: false, param: "btc", message: "btc must be 0-4 or null" };
      }
      params.btc = n;
    }
  }

  const btc_min = searchParams.get("btc_min");
  if (btc_min !== null) {
    const n = parseInt(btc_min, 10);
    if (Number.isNaN(n) || n < 0 || n > 4) {
      return { ok: false, param: "btc_min", message: "btc_min must be 0-4" };
    }
    params.btc_min = n;
  }

  const btc_any = searchParams.get("btc_any");
  if (btc_any !== null) {
    if (btc_any !== "1" && btc_any !== "0") {
      return { ok: false, param: "btc_any", message: "btc_any must be 0 or 1" };
    }
    params.btc_any = btc_any === "1";
  }

  const parsePayList = (key: "pay" | "pay_all", raw: string | null): { ok: true; list: string[] } | { ok: false; param: string; message: string } => {
    if (!raw) return { ok: true, list: [] };
    const list = raw.split(",").map((s) => s.trim());
    for (const c of list) {
      const base = c.split(":")[0]!;
      const valid = PAY_CODES.includes(base as (typeof PAY_CODES)[number]) || base.startsWith("bnpl") || base.startsWith("oth");
      if (!valid && !PAY_CODES.some((p) => c.startsWith(p))) {
        return { ok: false, param: key, message: `invalid pay code: ${c}` };
      }
    }
    return { ok: true, list };
  };

  const pay = searchParams.get("pay");
  const payParsed = parsePayList("pay", pay);
  if (!payParsed.ok) return payParsed;
  if (payParsed.list.length) params.pay = payParsed.list;

  const pay_all = searchParams.get("pay_all");
  const payAllParsed = parsePayList("pay_all", pay_all);
  if (!payAllParsed.ok) return payAllParsed;
  if (payAllParsed.list.length) params.pay_all = payAllParsed.list;

  const pay_group = searchParams.get("pay_group");
  if (pay_group) {
    if (!(pay_group in PAY_GROUPS)) {
      return { ok: false, param: "pay_group", message: `invalid pay_group; use bitcoin, lightning, or ecash` };
    }
    params.pay_group = pay_group;
  }

  const scope = searchParams.get("scope") ?? "any";
  if (!["online", "instore", "unscoped", "any"].includes(scope)) {
    return { ok: false, param: "scope", message: "invalid scope" };
  }
  params.scope = scope as QueryParams["scope"];

  const parseArList = (key: "no_ar" | "ar", raw: string | null): { ok: true; list: string[] } | { ok: false; param: string; message: string } => {
    if (!raw) return { ok: true as const, list: [] as string[] };
    const list = raw.split(",").map((s) => s.trim());
    for (const c of list) {
      if (!AR_CODES.includes(c as (typeof AR_CODES)[number])) {
        return { ok: false as const, param: key, message: `invalid ar code: ${c}` };
      }
    }
    return { ok: true as const, list };
  };

  const no_ar = parseArList("no_ar", searchParams.get("no_ar"));
  if (!no_ar.ok) return no_ar;
  if (no_ar.list.length) params.no_ar = no_ar.list;

  const ar = parseArList("ar", searchParams.get("ar"));
  if (!ar.ok) return ar;
  if (ar.list.length) params.ar = ar.list;

  for (const [key, field] of [["ag_min", "ag_min"], ["co_min", "co_min"], ["ease_min", "ease_min"]] as const) {
    const v = searchParams.get(key);
    if (v !== null) {
      const n = parseInt(v, 10);
      if (Number.isNaN(n)) return { ok: false, param: key, message: `${key} must be integer` };
      params[field] = n;
    }
  }

  const guest = searchParams.get("guest");
  if (guest !== null) {
    if (guest !== "1" && guest !== "0") {
      return { ok: false, param: "guest", message: "guest must be 0 or 1" };
    }
    params.guest = parseInt(guest, 10);
  }

  const tos = searchParams.get("tos");
  if (tos) {
    if (!["ok", "bans-automation", "unknown"].includes(tos)) {
      return { ok: false, param: "tos", message: "tos must be ok, bans-automation, or unknown" };
    }
    params.tos = tos;
  }

  const kyc = searchParams.get("kyc");
  if (kyc) params.kyc = kyc;

  const cat = searchParams.get("cat");
  if (cat) {
    const list = cat.split(",").map((s) => s.trim());
    for (const c of list) {
      if (!CAT_CODES.includes(c as (typeof CAT_CODES)[number])) {
        return { ok: false, param: "cat", message: `invalid cat: ${c}` };
      }
    }
    params.cat = list;
  }

  const sort = searchParams.get("sort");
  params.sort = sort ? sort.split(",").map((s) => s.trim()) : DEFAULT_SORT;

  let limit = 50;
  const limitRaw = searchParams.get("limit");
  if (limitRaw !== null) {
    limit = parseInt(limitRaw, 10);
    if (Number.isNaN(limit) || limit < 1 || limit > 500) {
      return { ok: false, param: "limit", message: "limit must be 1-500" };
    }
  }
  params.limit = limit;

  const cursor = searchParams.get("cursor");
  if (cursor) params.cursor = cursor;

  return { ok: true, params };
}

function payMaskForScope(row: IndexRow, scope: QueryParams["scope"]): number {
  switch (scope) {
    case "online": return row.pay_online;
    case "instore": return row.pay_instore;
    case "unscoped": return row.pay_unscoped;
    default: return row.pay_any;
  }
}

function matches(row: IndexRow, p: QueryParams): boolean {
  if (p.q) {
    const hay = `${row.d} ${row.name ?? ""}`.toLowerCase();
    if (!hay.includes(p.q)) return false;
  }

  if (p.reachable) {
    if (row.status !== "crawled" || row.ag === null || row.ag < 1) return false;
  }

  if (p.status?.length) {
    if (!p.status.includes(row.status)) return false;
  }

  if (p.btc !== undefined) {
    if (p.btc === null) {
      if (row.btc !== null) return false;
    } else if (row.btc !== p.btc) return false;
  }

  if (p.btc_min !== undefined) {
    if (row.btc === null || row.btc < p.btc_min) return false;
  }

  if (p.btc_any === true) {
    if (row.btc_any !== 1 && !(row.btc !== null && row.btc > 0)) return false;
  }

  const scope = p.scope ?? "any";
  const payMask = payMaskForScope(row, scope);

  if (p.pay_group) {
    const gm = PAY_GROUPS[p.pay_group]!;
    if ((payMask & gm) === 0) return false;
  }

  if (p.pay?.length) {
    let any = false;
    for (const c of p.pay) {
      if (payMask & payCodeToBit(c)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }

  if (p.pay_all?.length) {
    for (const c of p.pay_all) {
      if ((payMask & payCodeToBit(c)) === 0) return false;
    }
  }

  if (p.no_ar?.length) {
    for (const c of p.no_ar) {
      if (row.ar_mask & arCodeToBit(c)) return false;
    }
  }

  if (p.ar?.length) {
    let any = false;
    for (const c of p.ar) {
      if (row.ar_mask & arCodeToBit(c)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }

  if (p.ag_min !== undefined) {
    if (row.ag === null || row.ag < p.ag_min) return false;
  }

  if (p.co_min !== undefined) {
    if (row.co === null || row.co < p.co_min) return false;
  }

  if (p.ease_min !== undefined) {
    if (row.ease === null || row.ease < p.ease_min) return false;
  }

  if (p.guest !== undefined) {
    if (row.guest !== p.guest) return false;
  }

  if (p.tos) {
    if (p.tos === "unknown") {
      if (row.tos !== null) return false;
    } else if (row.tos !== p.tos) return false;
  }

  if (p.kyc) {
    if (row.kyc !== p.kyc) return false;
  }

  if (p.cat?.length) {
    let any = false;
    for (const c of p.cat) {
      if (row.cat_mask & catCodeToBit(c)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }

  return true;
}

function sortKey(row: IndexRow, field: string): number | string | null {
  const desc = field.startsWith("-");
  const f = desc ? field.slice(1) : field;
  let val: number | string | null;
  switch (f) {
    case "d": val = row.d; break;
    case "name": val = row.name ?? ""; break;
    case "btc": val = row.btc; break;
    case "ag": val = row.ag; break;
    case "co": val = row.co; break;
    case "ease": val = row.ease; break;
    case "ts": val = row.ts; break;
    default: val = row.d;
  }
  return val;
}

function compareRows(a: IndexRow, b: IndexRow, sortFields: string[]): number {
  for (const field of sortFields) {
    const desc = field.startsWith("-");
    const f = desc ? field.slice(1) : field;
    let av = sortKey(a, field);
    let bv = sortKey(b, field);
    if (typeof av === "number" || av === null) {
      if (av === null && bv === null) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      const diff = (av as number) - (bv as number);
      if (diff !== 0) return desc ? -diff : diff;
    } else {
      const diff = String(av).localeCompare(String(bv));
      if (diff !== 0) return desc ? -diff : diff;
    }
  }
  return a.d.localeCompare(b.d);
}

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}

function decodeCursor(cursor: string): number | null {
  try {
    const n = parseInt(atob(cursor), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export function querySnapshot(snap: Snapshot, params: QueryParams): QueryResult {
  const t0 = performance.now();
  const matched: IndexRow[] = [];
  for (const row of snap.rows) {
    if (matches(row, params)) matched.push(row);
  }

  const sortFields = params.sort ?? DEFAULT_SORT;
  matched.sort((a, b) => compareRows(a, b, sortFields));

  const total = matched.length;
  let offset = 0;
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded !== null) offset = decoded;
  }

  const limit = params.limit ?? 50;
  const page = matched.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const next = nextOffset < total ? encodeCursor(nextOffset) : null;
  const filter_ms = performance.now() - t0;

  return {
    total,
    count: page.length,
    next,
    items: page,
    filter_ms,
  };
}

export { KNOWN_PARAMS };
