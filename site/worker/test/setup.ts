import { applyD1Migrations, env } from "cloudflare:test";
import { bootstrapFixtures } from "../src/router";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const fixture = env.FIXTURE_NDJSON as string | undefined;
if (fixture?.trim()) {
  await bootstrapFixtures(env as never, fixture);
}
