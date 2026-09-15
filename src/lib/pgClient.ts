// A minimal Postgres connection pool, decoupled from any specific store
// implementation.
//
// Why this exists: PgOrderStore only needs a pool to check out clients from
// for transactions (BEGIN/COMMIT/ROLLBACK) and to run one-off queries. This
// mirrors the pattern in redisClient.ts and eventBus.ts — the resource is
// wired up once here, and consumers (PgOrderStore) depend on `pg`'s own
// Pool type directly rather than a hand-rolled interface, since `pg` is
// already a hard dependency once ORDER_STORE=pg is in use (there's no
// zero-dependency fallback for Postgres the way there is for Redis).

import { Pool, type PoolConfig } from "pg";

let pool: Pool | undefined;

/**
 * Returns a process-wide singleton Pool built from DATABASE_URL (see
 * .env.example). Call this once at startup (server.ts) and pass the pool
 * into PgOrderStore — don't call `new Pool()` anywhere else, so there's
 * exactly one connection pool for the whole process.
 */
export function getPgPool(config: PoolConfig = {}): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Required when ORDER_STORE=pg — see .env.example."
    );
  }

  pool = new Pool({
    connectionString,
    // Keep this explicit and small rather than relying on pg's default (10).
    // Size it to your load-test concurrency, not a guess — see
    // tests/concurrency.load.test.ts for what "concurrent" means here.
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });

  pool.on("error", (err) => {
    // Fired on an idle client error (e.g. the DB restarted underneath us) —
    // without this handler `pg` treats it as an uncaught exception and
    // crashes the process. Log and let /readyz's next Postgres check surface
    // the outage instead.
    console.error("Unexpected error on idle Postgres client", err);
  });

  return pool;
}

/** For tests: closes the pool so Vitest doesn't hang on an open handle. */
export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}