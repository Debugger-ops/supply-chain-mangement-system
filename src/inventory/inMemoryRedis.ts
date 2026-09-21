// In-process RedisLike implementation for local dev / seed / tests when no
// real Redis is reachable — no `docker`, no `redis-server`, and (in a
// locked-down sandbox) no root/network to install either.
//
// Every other piece of infra in this repo already has an in-process
// fallback: buildEventBus() falls back to InMemoryEventBus when
// KAFKA_BROKERS is unset, buildOrderStore()/buildBusinessStore() fall back
// to InMemoryOrderStore/InMemoryBusinessStore unless ORDER_STORE=pg. Redis
// was the one exception — RawRespClient/IoRedisClient were the only two
// options, both requiring an actual server — which is why `npm run seed`
// (and most of the test suite) simply couldn't run at all without one.
// This is the same pattern applied to Redis, opt-in via REDIS_DRIVER=memory
// (see connectRedis.ts) rather than a silent default, because unlike Kafka
// or order storage, Redis is where this project's actual correctness
// mechanism (atomic reserve/release, "never oversell under concurrency")
// lives — see docs/architecture.md.
//
// IMPORTANT — what this is NOT:
//   - Not a general-purpose Redis emulator. It doesn't parse or run
//     arbitrary Lua. It recognizes exactly the two scripts InventoryService
//     ships (RESERVE_SCRIPT / RELEASE_SCRIPT, imported from ./scripts.js —
//     the same constants InventoryService itself sends to a real Redis) and
//     re-implements their exact semantics natively in TypeScript, so
//     behavior matches running against real Redis for anything this repo's
//     code actually calls eval() with. Any other script throws immediately
//     instead of silently doing the wrong thing.
//   - Not a substitute for real Redis in scripts/verify.ts or the
//     correctness/concurrency test suite (tests/inventory.test.ts,
//     tests/concurrency.load.test.ts, etc.). Everything here runs
//     synchronously in one JS Map in one process, so it cannot exercise —
//     and would trivially "pass" — the exact failure mode
//     (cross-connection, cross-process races) those exist to catch. Use it
//     for unblocking `npm run seed` / `npm run dev` / a quick test run with
//     nothing installed, not for validating the reservation logic itself.

import { RedisReplyError, type RedisLike } from "../lib/redisClient.js";
import { RESERVE_SCRIPT, RELEASE_SCRIPT } from "./scripts.js";

export class InMemoryRedisClient implements RedisLike {
  private store = new Map<string, string>();
  private expiresAt = new Map<string, number>();

  /** Mirrors Redis's passive expiry: a key past its TTL reads back as gone. */
  private isLive(key: string): boolean {
    const exp = this.expiresAt.get(key);
    if (exp !== undefined && exp <= Date.now()) {
      this.store.delete(key);
      this.expiresAt.delete(key);
      return false;
    }
    return this.store.has(key);
  }

  async get(key: string): Promise<string | null> {
    return this.isLive(key) ? this.store.get(key)! : null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    this.expiresAt.delete(key); // plain SET clears any existing TTL, same as real Redis
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.isLive(key)) count++;
      this.store.delete(key);
      this.expiresAt.delete(key);
    }
    return count;
  }

  async eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown> {
    const keys = keysAndArgs.slice(0, numKeys).map(String);
    const args = keysAndArgs.slice(numKeys);

    if (script === RESERVE_SCRIPT) return this.evalReserve(keys, args);
    if (script === RELEASE_SCRIPT) return this.evalRelease(keys, args);
    throw new Error(
      "InMemoryRedisClient.eval() only knows InventoryService's reserve.lua / release.lua " +
        "(compared by exact text against src/inventory/scripts.ts) and got something else. " +
        "Set REDIS_DRIVER=raw or =ioredis against a real Redis instead."
    );
  }

  // Mirrors src/inventory/reserve.lua exactly — see that file for the
  // step-by-step reasoning (UNKNOWN_SKU vs INSUFFICIENT_STOCK vs the
  // INVALID_QTY error reply).
  private evalReserve(keys: string[], args: (string | number)[]): [string, number] {
    const [stockKey, resvKey] = keys;
    const qty = Number(args[0]);
    const reservationId = String(args[1]);
    const ttlSeconds = Number(args[2]);

    if (!Number.isFinite(qty) || qty <= 0) {
      throw new RedisReplyError("INVALID_QTY");
    }

    if (!this.isLive(stockKey)) return ["UNKNOWN_SKU", 0];
    const available = Number(this.store.get(stockKey));

    if (available < qty) return ["INSUFFICIENT_STOCK", available];

    const remaining = available - qty;
    this.store.set(stockKey, String(remaining));
    this.store.set(resvKey, String(qty));
    this.expiresAt.set(resvKey, Date.now() + ttlSeconds * 1000);
    void reservationId; // not needed for the in-memory value keyed by resvKey itself
    return ["OK", remaining];
  }

  // Mirrors src/inventory/release.lua exactly.
  private evalRelease(keys: string[], args: (string | number)[]): [string, number] {
    const [stockKey, resvKey] = keys;
    const mode = String(args[0]);

    if (!this.isLive(resvKey)) return ["ALREADY_RESOLVED", 0];
    const qty = Number(this.store.get(resvKey));
    this.store.delete(resvKey);
    this.expiresAt.delete(resvKey);

    if (mode === "RELEASE") {
      const current = this.isLive(stockKey) ? Number(this.store.get(stockKey)) : 0;
      this.store.set(stockKey, String(current + qty));
      return ["RELEASED", qty];
    }
    if (mode === "COMMIT") return ["COMMITTED", qty];
    throw new RedisReplyError("INVALID_MODE");
  }

  async quit(): Promise<void> {
    // Nothing to tear down — no socket, no handle.
  }
}
