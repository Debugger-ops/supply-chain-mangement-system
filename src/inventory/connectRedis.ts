import { RawRespClient, createIoRedisClient, type RedisLike } from "../lib/redisClient.js";
import { InMemoryRedisClient } from "./inMemoryRedis.js";

// Turns REDIS_DRIVER / REDIS_HOST / REDIS_PORT / REDIS_URL into a connected
// RedisLike. Used by src/api/server.ts and scripts/seed.ts, which
// previously each inlined their own copy of this same switch — the two
// copies had already drifted (scripts/seed.ts had no equivalent of the
// actionable error message below, so a missing Redis there just surfaced
// as a bare ECONNREFUSED stack trace with no pointer to a fix).
//
// scripts/verify.ts deliberately does NOT use this — it talks to
// RawRespClient directly and fails loudly with nothing but a real Redis,
// because its whole purpose is producing genuine performance numbers
// against genuine infra (see docs/RESUME_BULLETS.md). Routing it through
// here, where REDIS_DRIVER=memory is one env var away, would let it
// silently benchmark a JS Map instead of Redis.
//
// Three explicit driver values — no behavior that changes based on what a
// connection attempt happens to do at runtime:
//   - "ioredis"     -> real Redis via the `ioredis` package (production).
//   - "memory"      -> InMemoryRedisClient: no external process at all.
//                      See inMemoryRedis.ts for exactly what it does and
//                      does not cover before reaching for this — it is not
//                      a substitute for real Redis in anything that's
//                      supposed to prove the reservation logic is correct
//                      under concurrency.
//   - unset / "raw" -> RawRespClient against a real local Redis (today's
//                      zero-dependency default). If nothing is listening,
//                      this throws an error that names REDIS_DRIVER=memory
//                      as the fallback, instead of a raw ECONNREFUSED with
//                      no next step.
export async function connectRedis(): Promise<RedisLike> {
  const driver = process.env.REDIS_DRIVER;

  if (driver === "ioredis") {
    return createIoRedisClient(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  }
  if (driver === "memory") {
    return new InMemoryRedisClient();
  }

  const host = process.env.REDIS_HOST ?? "127.0.0.1";
  const port = Number(process.env.REDIS_PORT ?? 6379);
  const client = new RawRespClient(host, port);
  try {
    await client.get("__connect_probe__"); // cheap round-trip; throws if nothing's listening
    return client;
  } catch (err) {
    await client.quit().catch(() => {}); // best-effort — the socket most likely never connected
    if (isConnectionRefused(err)) {
      throw new Error(
        `Redis isn't reachable at ${host}:${port} (ECONNREFUSED). Either start a real one ` +
          "(`docker compose up redis`, or `redis-server &` — see README \"Option B\") and rerun, " +
          "or set REDIS_DRIVER=memory for an in-process fallback with no external Redis at all " +
          "(fine for `npm run seed` / `npm run dev`; see src/inventory/inMemoryRedis.ts for what " +
          "it does and doesn't cover before relying on it for anything else).",
        { cause: err }
      );
    }
    throw err;
  }
}

function isConnectionRefused(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ECONNREFUSED";
}
