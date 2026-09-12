import { describe, it, expect, afterAll } from "vitest";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { RawRespClient } from "../src/lib/redisClient.js";
import { getTestRedisClient } from "./setup.js";
import type { RedisLike } from "../src/lib/redisClient.js";

// Heavier concurrency/latency tests, kept separate from inventory.test.ts so
// `vitest run tests/inventory.test.ts` stays fast during normal development
// and this file can be run on its own for a benchmark pass:
//   npx vitest run tests/concurrency.load.test.ts
describe("Concurrency & latency benchmarks", () => {
  const clientsToClose: RedisLike[] = [];
  afterAll(async () => {
    await Promise.all(clientsToClose.map((c) => c.quit()));
  });

  it("enforces an exact stock quota across 10 simulated app instances hitting Redis concurrently", async () => {
    const STOCK = 200;
    const INSTANCES = 10;
    const REQUESTS_PER_INSTANCE = 150;

    const primaryRedis = await getTestRedisClient();
    clientsToClose.push(primaryRedis);
    const primaryInventory = new InventoryService(primaryRedis);
    await primaryInventory.setStock("wh-load", "sku-load-test", STOCK);

    const instanceServices = Array.from({ length: INSTANCES }, () => {
      const client = new RawRespClient();
      clientsToClose.push(client);
      return new InventoryService(client);
    });

    const start = performance.now();
    const results = await Promise.all(
      instanceServices.flatMap((svc) =>
        Array.from({ length: REQUESTS_PER_INSTANCE }, () => svc.reserve("wh-load", "sku-load-test", 1))
      )
    );
    const elapsedMs = performance.now() - start;
    const accepted = results.filter((r) => r.ok).length;

    expect(accepted).toBe(STOCK);
    expect(await primaryInventory.getAvailable("wh-load", "sku-load-test")).toBe(0);

    const totalRequests = INSTANCES * REQUESTS_PER_INSTANCE;
    console.log(
      `[benchmark] ${totalRequests} requests across ${INSTANCES} instances in ${elapsedMs.toFixed(1)}ms ` +
        `(${(totalRequests / (elapsedMs / 1000)).toFixed(0)} req/s), exactly ${accepted}/${STOCK} accepted.`
    );
  });

  it("keeps p99 single-reservation latency under 5ms against local Redis", async () => {
    const redis = await getTestRedisClient();
    clientsToClose.push(redis);
    const inventory = new InventoryService(redis);
    const SAMPLES = 500;
    await inventory.setStock("wh-latency", "sku-latency-test", SAMPLES + 100);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      await inventory.reserve("wh-latency", "sku-latency-test", 1);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    console.log(`[benchmark] p50=${samples[Math.floor(samples.length * 0.5)].toFixed(3)}ms p99=${p99.toFixed(3)}ms`);

    expect(p99).toBeLessThan(5);
  });
});
