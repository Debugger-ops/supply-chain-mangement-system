import type { Pool } from "pg";
import { RawRespClient } from "../src/lib/redisClient.js";
import { getPgPool } from "../src/lib/pgClient.js";

// Tests default to the zero-dependency RawRespClient against a real local
// redis-server (see README "Running tests" for the one-line setup) so the
// suite runs the same way in this repo's own CI sandbox and on a laptop
// with `ioredis` installed. Set TEST_REDIS_DRIVER=ioredis to run the same
// suite against the production client instead.
export async function getTestRedisClient() {
  if (process.env.TEST_REDIS_DRIVER === "ioredis") {
    const { createIoRedisClient } = await import("../src/lib/redisClient.js");
    return createIoRedisClient(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  }
  return new RawRespClient(process.env.REDIS_HOST ?? "127.0.0.1", Number(process.env.REDIS_PORT ?? 6379));
}

/**
 * A Postgres pool for tests/pgOrderStore.test.ts, pointed at DATABASE_URL
 * (see .env.example — defaults to the database `docker compose up postgres`
 * provisions). Mirrors getTestRedisClient() above: one shared connection,
 * one env var, same pattern as the rest of this file — just for the other
 * piece of local infra PgOrderStore needs.
 *
 * Deliberately synchronous, matching how pgOrderStore.test.ts calls it
 * (`new PgOrderStore(getTestPgPool())` inside a non-async beforeAll) — pg's
 * Pool connects lazily on first query, so there's no connection to await
 * here. Schema provisioning is docker-compose's job, not this helper's: see
 * docker-compose.yml's postgres service, which mounts docs/schema.sql as a
 * docker-entrypoint-initdb.d script and runs it automatically on first
 * boot — bring that up (`docker compose up postgres`) before running this
 * suite. Call closePgPool() (src/lib/pgClient.ts) in afterAll so Vitest
 * doesn't hang on an open handle.
 */
export function getTestPgPool(): Pool {
  return getPgPool();
}
