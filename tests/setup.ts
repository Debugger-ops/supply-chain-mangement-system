import { RawRespClient } from "../src/lib/redisClient.js";

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
