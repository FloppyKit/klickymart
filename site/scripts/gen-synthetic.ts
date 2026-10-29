#!/usr/bin/env npx tsx
/** Generate records.synthetic.ndjson (≥30 rows, *.example domains). */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const arCodes = ["rb_ai", "rb_ck", "cf", "ak", "px", "cap", "cap!", "403", "tarpit", "hl", "js", "tos", "acct", "geo"];
const lines: string[] = [];
const baseTs = 1793292000;

for (let i = 0; i < 35; i++) {
  const d = `shop-${i}.example`;
  const btc = i % 5 === 4 ? null : (i % 5) as number;
  const pays = i % 3 === 0 ? ["ln", "btc"] : i % 3 === 1 ? ["cashu"] : ["card"];
  const scope = i % 3 === 0 ? "online" : i % 3 === 1 ? "in-store" : null;
  const pay_q = pays.map((c) => ({
    c,
    neg: false,
    url: `https://${d}/pay`,
    q: `Example accepts ${c}.`,
    conf: "med",
    scope,
  }));
  const pay_online = scope === "online" ? pays : scope === null && i % 2 ? pays : [];
  const pay_instore = scope === "in-store" ? pays : [];
  const pay_unscoped = scope === null && !pay_online.length ? pays : [];
  const ar = [{ c: arCodes[i % arCodes.length], at: "home", ev: `https://${d}/`, n: "example restriction" }];
  const rec = {
    d,
    cat: ["gen"],
    v: "0.3-draft",
    ts: baseTs + i,
    ua: "FloppyKitMapBot/0.2 (+https://klickymart.com/bot; bot@klickymart.com)",
    vantage: { ip: "single-datacenter", n: "test synthetic" },
    status: "crawled",
    name: `Example Shop ${i}`,
    name_ev: `https://${d}/`,
    ag: (i % 4) as number,
    co: (i % 4) as number,
    steps: 2 + (i % 3),
    guest: i % 2 === 0 ? 1 : 0,
    kyc: i % 3 === 0 ? "none-stated" : null,
    tos: "ok",
    tos_url: `https://${d}/terms`,
    ar: i % 5 === 0 ? ar : [],
    pay: pays,
    pay_no: [],
    pay_q,
    pay_online,
    pay_instore,
    pay_unscoped,
    pay_src: "observed-rendered-pages",
    evu: [`https://${d}/pay`],
    btc,
    btc_any: btc === null ? true : btc > 0,
    btc_conf: "med",
    conf: "med",
  };
  lines.push(JSON.stringify(rec));
}

const out = join(dir, "../fixtures/records.synthetic.ndjson");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`Wrote ${lines.length} records to ${out}`);
