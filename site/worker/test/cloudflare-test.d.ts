/// <reference types="@cloudflare/vitest-pool-workers" />

declare module "cloudflare:test" {
  export const env: Env;
  export const SELF: { fetch: typeof fetch };
  export function applyD1Migrations(db: D1Database, migrations: unknown): Promise<void>;
}
