import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NdjsonFileSource, ingestFromLines } from "../src/ingest";
import { rowsToSnapshot } from "../src/index-mem";
import { querySnapshot } from "../src/query";

const dir = dirname(fileURLToPath(import.meta.url));

async function loadSnap(n: number) {
  const sample = readFileSync(join(dir, "../../fixtures/records.sample.ndjson"), "utf8");
  let synth = "";
  try {
    synth = readFileSync(join(dir, "../../fixtures/records.synthetic.ndjson"), "utf8");
  } catch { /* */ }
  const base = [...sample.split("\n"), ...synth.split("\n")].filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const src = base[i % base.length]!;
    const o = JSON.parse(src);
    o.d = `bench-${i}.example`;
    o.ts = 1793290000 + i;
    lines.push(JSON.stringify(o));
  }
  const { rows } = await ingestFromLines(
    (async function* () {
      for (const l of lines) yield JSON.parse(l);
    })(),
    { allowSynthetic: true },
  );
  return rowsToSnapshot([...rows.values()], "bench", "bench");
}

const combos: Record<string, string>[] = [
  { reachable: "1" },
  { pay: "ln", pay_group: "lightning" },
  { btc_min: "3" },
  { status: "crawled,agents-not-welcome" },
  { q: "dell" },
  { no_ar: "cf,cap" },
  { sort: "-btc,name" },
  { cat: "elec" },
  { guest: "1" },
  { tos: "unknown" },
  { pay: "card", scope: "instore" },
  { pay_all: "card,ln" },
  { ar: "rb_ai" },
  { ag_min: "2" },
  { co_min: "1" },
  { ease_min: "1" },
  { btc_any: "1" },
  { pay_group: "bitcoin" },
  { pay_group: "ecash" },
  { kyc: "none-stated" },
];

function pctl(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((p / 100) * s.length)] ?? 0;
}

async function benchSize(n: number) {
  const snap = await loadSnap(n);
  const times: number[] = [];
  const iterations = n >= 50_000 ? 100 : 1000;
  for (const combo of combos) {
    for (let i = 0; i < iterations; i++) {
      const sp = new URLSearchParams(combo);
      const { validateQueryParams } = await import("../src/query");
      const v = validateQueryParams(sp);
      if (!v.ok) continue;
      const r = querySnapshot(snap, v.params);
      times.push(r.filter_ms);
    }
  }
  return {
    n,
    p50: pctl(times, 50),
    p95: pctl(times, 95),
    p99: pctl(times, 99),
  };
}

const sizes = [250, 10_000, 100_000];
const results = [];
for (const n of sizes) {
  results.push(await benchSize(n));
  console.log(`${n} records: p50=${results.at(-1)!.p50.toFixed(3)}ms p95=${results.at(-1)!.p95.toFixed(3)}ms`);
}

writeFileSync(join(dir, "result.json"), JSON.stringify({ results, combos: combos.length, iterationsNote: "100k uses 100 iter/combo" }, null, 2));

const r10k = results.find((r) => r.n === 10_000)!;
const r250 = results.find((r) => r.n === 250)!;
if (r10k.p50 >= 10 || r250.p50 >= 10) {
  console.error("FAIL: p50 must be < 10ms at 250 and 10k");
  process.exit(1);
}
