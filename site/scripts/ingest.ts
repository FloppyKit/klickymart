#!/usr/bin/env npx tsx
import { readFileSync } from "node:fs";
import { NdjsonFileSource, persistIngest, ingestFromLines } from "../worker/src/ingest";

const args = process.argv.slice(2);
let file = "fixtures/records.sample.ndjson";
let allowSynthetic = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file" && args[i + 1]) file = args[++i]!;
  if (args[i] === "--allow-synthetic") allowSynthetic = true;
  if (args[i] === "--remote") {
    console.log("Remote ingest: run wrangler d1 execute with generated SQL (not implemented in v1 CLI stub).");
    process.exit(0);
  }
}

const text = readFileSync(file, "utf8");
const src = new NdjsonFileSource(text);
const { rows, report } = await ingestFromLines(src.read(), { allowSynthetic, sourceLabel: "file" });
console.log(JSON.stringify(report, null, 2));
if (report.rejected.length) {
  console.error("Rejected:", report.rejected.slice(0, 5));
}
await persistIngest(rows, report, {});
console.log(`Upserted ${report.upserted} records`);
