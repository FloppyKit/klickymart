import {
  AR_BIT,
  CAT_BIT,
  PAY_BIT,
  STATUS_CODE,
  STATUS_VALUES,
  payCodeToBit,
  arCodeToBit,
  catCodeToBit,
  type StatusValue,
} from "./codes";

export interface RecordRow {
  d: string;
  name: string | null;
  name_ev: string | null;
  status: StatusValue;
  status_code: number;
  ts: number;
  v: string;
  cat_mask: number;
  ag: number | null;
  co: number | null;
  steps: number | null;
  guest: number | null;
  kyc: string | null;
  tos: string | null;
  tos_url: string | null;
  tos_q: string | null;
  btc: number | null;
  btc_any: number | null;
  btc_conf: string | null;
  conf: string | null;
  pay_any: number;
  pay_online: number;
  pay_instore: number;
  pay_unscoped: number;
  pay_no: number;
  ar_mask: number;
  anw_type: string | null;
  ease: number | null;
  search: string;
  raw_json: string;
  source: string;
  event_id: string | null;
  pubkey: string | null;
  sig: string | null;
  ingested_at: number;
}

export type RawRecord = Record<string, unknown>;

export function computeEase(status: StatusValue, co: number | null, ag: number | null): number | null {
  if (status !== "crawled") return null;
  if (co !== null && co !== undefined) return co;
  if (ag === 0) return 0;
  return null;
}

function payListToMask(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  let m = 0;
  for (const item of list) {
    if (typeof item === "string") m |= payCodeToBit(item);
  }
  return m;
}

function buildSearch(d: string, name: string | null, cat: string[], payCodes: string[], arCodes: string[]): string {
  const parts = [d, name ?? "", ...cat, ...payCodes, ...arCodes];
  return parts.join(" ").toLowerCase();
}

export type NormalizeResult =
  | { ok: true; row: RecordRow }
  | { ok: false; reason: string };

export function normalize(raw: RawRecord, source: string, ingestedAt: number): NormalizeResult {
  const dRaw = raw.d;
  if (typeof dRaw !== "string" || !dRaw.trim()) {
    return { ok: false, reason: "missing or invalid d" };
  }
  const d = dRaw.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
    return { ok: false, reason: "invalid domain format" };
  }

  const statusRaw = raw.status;
  if (typeof statusRaw !== "string" || !STATUS_VALUES.includes(statusRaw as StatusValue)) {
    return { ok: false, reason: "invalid status" };
  }
  const status = statusRaw as StatusValue;

  const ts = raw.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return { ok: false, reason: "invalid ts" };
  }

  const v = raw.v;
  if (typeof v !== "string" || !v) {
    return { ok: false, reason: "invalid v" };
  }

  let cat_mask = 0;
  if (Array.isArray(raw.cat)) {
    for (const c of raw.cat) {
      if (typeof c === "string") cat_mask |= catCodeToBit(c);
    }
  }

  const ag = typeof raw.ag === "number" ? raw.ag : raw.ag === null ? null : null;
  const co = typeof raw.co === "number" ? raw.co : raw.co === null ? null : null;
  const steps = typeof raw.steps === "number" ? raw.steps : raw.steps === null ? null : null;
  let guest: number | null = null;
  if (raw.guest === true) guest = 1;
  else if (raw.guest === false) guest = 0;
  else if (raw.guest === null) guest = null;

  const kyc = typeof raw.kyc === "string" ? raw.kyc : raw.kyc === null ? null : null;
  const tos = typeof raw.tos === "string" ? raw.tos : raw.tos === null ? null : null;
  const tos_url = typeof raw.tos_url === "string" ? raw.tos_url : null;
  const tos_q = typeof raw.tos_q === "string" ? raw.tos_q : null;

  let btc: number | null = null;
  if (typeof raw.btc === "number") btc = raw.btc;
  else if (raw.btc === null) btc = null;

  let btc_any: number | null = null;
  if (raw.btc_any === true) btc_any = 1;
  else if (raw.btc_any === false) btc_any = 0;
  else if (raw.btc_any === null) btc_any = null;

  const btc_conf = typeof raw.btc_conf === "string" ? raw.btc_conf : null;
  const conf = typeof raw.conf === "string" ? raw.conf : null;

  const pay_any = payListToMask(raw.pay);
  const pay_online = payListToMask(raw.pay_online);
  const pay_instore = payListToMask(raw.pay_instore);
  const pay_unscoped = payListToMask(raw.pay_unscoped);
  const pay_no = payListToMask(raw.pay_no);

  let ar_mask = 0;
  const arCodes: string[] = [];
  if (Array.isArray(raw.ar)) {
    for (const entry of raw.ar) {
      if (entry && typeof entry === "object" && "c" in entry && typeof (entry as { c: unknown }).c === "string") {
        const c = (entry as { c: string }).c;
        arCodes.push(c);
        ar_mask |= arCodeToBit(c);
      }
    }
  }

  let anw_type: string | null = null;
  if (raw.anw && typeof raw.anw === "object" && "type" in (raw.anw as object)) {
    const t = (raw.anw as { type: unknown }).type;
    if (typeof t === "string") anw_type = t;
  }

  const name = typeof raw.name === "string" ? raw.name : raw.name === null ? null : null;
  const name_ev = typeof raw.name_ev === "string" ? raw.name_ev : null;

  const payCodes: string[] = [];
  if (Array.isArray(raw.pay)) {
    for (const p of raw.pay) if (typeof p === "string") payCodes.push(p);
  }

  const ease = computeEase(status, co, ag);
  const search = buildSearch(d, name, Array.isArray(raw.cat) ? raw.cat.filter((x): x is string => typeof x === "string") : [], payCodes, arCodes);

  const row: RecordRow = {
    d,
    name,
    name_ev,
    status,
    status_code: STATUS_CODE[status],
    ts,
    v,
    cat_mask,
    ag,
    co,
    steps,
    guest,
    kyc,
    tos,
    tos_url,
    tos_q,
    btc,
    btc_any,
    btc_conf,
    conf,
    pay_any,
    pay_online,
    pay_instore,
    pay_unscoped,
    pay_no,
    ar_mask,
    anw_type,
    ease,
    search,
    raw_json: JSON.stringify(raw),
    source,
    event_id: typeof raw.event_id === "string" ? raw.event_id : null,
    pubkey: typeof raw.pubkey === "string" ? raw.pubkey : null,
    sig: typeof raw.sig === "string" ? raw.sig : null,
    ingested_at: ingestedAt,
  };

  return { ok: true, row };
}

export function isExampleDomain(d: string): boolean {
  return d.endsWith(".example") || d.endsWith(".example.com") || d.includes(".example.");
}

export function rejectExampleUnlessAllowed(d: string, allowSynthetic: boolean): string | null {
  if (d.endsWith(".example") || /\.example(\.|$)/.test(d)) {
    if (!allowSynthetic) return "synthetic *.example domains rejected (use --allow-synthetic in tests)";
  }
  return null;
}
