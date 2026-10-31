import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const dir = path.dirname(fileURLToPath(import.meta.url));

function loadFixtures(): string {
  const sample = readFileSync(path.join(dir, "fixtures/records.sample.ndjson"), "utf8");
  let synth = "";
  try {
    synth = readFileSync(path.join(dir, "fixtures/records.synthetic.ndjson"), "utf8");
  } catch {
    /* optional */
  }
  return [sample, synth].filter(Boolean).join("\n");
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(dir, "worker/migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            FIXTURE_NDJSON: loadFixtures(),
            USE_TEST_FIXTURES: "1",
            AUTH_SECRET: "test-only-auth-secret",
            SUBMIT_SALT: "test-only-submit-salt",
            // R12-201: tests never dial real relays. The INGESTER DO (woken by /stats/ingest.json and others) connects to
            // RELAY_URLS; a closed local port fails instantly instead of hanging on the network.
            RELAY_URLS: "ws://127.0.0.1:1",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./worker/test/setup.ts"],
      exclude: ["**/e2e/**", "**/node_modules/**"],
    },
  };
});
