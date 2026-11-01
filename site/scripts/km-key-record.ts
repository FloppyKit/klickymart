/** M3 operator script (local only; Matt runs it). Builds and signs ONE key record and writes its JSON to stdout.
 * Keys are read ONLY from files whose PATHS are in env vars (never argv values); key bytes are never printed or logged.
 *   KM_KEY_FILE      path to the current/old key file (64 hex)     pin, rotate (old), revoke
 *   KM_NEW_KEY_FILE  path to the new key file (64 hex)             rotate (new)
 * Usage (non-secret args only):
 *   tsx scripts/km-key-record.ts pin
 *   tsx scripts/km-key-record.ts rotate --prev <record id> --last-good-head <head id>
 *   tsx scripts/km-key-record.ts revoke --last-good-head <head id>
 *   optional: --created-at <unix s> (default now)
 * The output is then appended to km_key_records by the operator (append-only table). */
import { readFileSync } from "node:fs";
import { hexToBytes } from "@noble/hashes/utils.js";
import { checkRecord, makePin, makeRevoke, makeRotate } from "../worker/src/key-records";

function die(m: string): never { process.stderr.write(`km-key-record: ${m}\n`); process.exit(2); }
function keyFrom(varName: string): Uint8Array {
  const p = process.env[varName]; if (!p) die(`${varName} (a file path) is not set`);
  let s: string; try { s = readFileSync(p, "utf8").trim(); } catch { die(`cannot read the file named by ${varName}`); }
  if (!/^[0-9a-f]{64}$/.test(s)) die(`file named by ${varName} is not 64 lowercase hex`); // never echo the content
  return hexToBytes(s);
}
const [cmd, ...rest] = process.argv.slice(2);
const args: Record<string, string> = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i]!, v = rest[i + 1];
  if (!["--prev", "--last-good-head", "--created-at"].includes(k) || v === undefined) die(`unknown or incomplete arg ${k}`);
  args[k] = v;
}
const hex = (k: string) => { const v = args[k]; if (!v || !/^[0-9a-f]{64}$/.test(v)) die(`${k} must be 64 lowercase hex`); return v; };
const ts = args["--created-at"] !== undefined ? Number(args["--created-at"]) : Math.floor(Date.now() / 1000);
if (!Number.isSafeInteger(ts) || ts < 0) die("--created-at must be a unix second count");
const rec = cmd === "pin" ? makePin(keyFrom("KM_KEY_FILE"), ts)
  : cmd === "rotate" ? makeRotate(keyFrom("KM_KEY_FILE"), keyFrom("KM_NEW_KEY_FILE"), hex("--prev"), hex("--last-good-head"), ts)
  : cmd === "revoke" ? makeRevoke(keyFrom("KM_KEY_FILE"), hex("--last-good-head"), ts)
  : die("first arg must be pin | rotate | revoke");
const c = checkRecord(rec); if (!c.ok) die(`built record does not verify: ${c.error}`);
process.stdout.write(JSON.stringify(rec) + "\n");
