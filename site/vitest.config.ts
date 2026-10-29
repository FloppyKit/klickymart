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
