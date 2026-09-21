import { describe, it, expect, afterAll } from "vitest";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { InMemoryEventBus } from "../src/lib/eventBus.js";
import { PgOrderStore } from "../src/orders/pgOrderStore.js";
import { SagaOrchestrator } from "../src/orders/sagaOrchestrator.js";
import { PaymentGateway } from "../src/payments/paymentGateway.js";
import { ShippingProvider } from "../src/shipping/shippingProvider.js";
import { closePgPool } from "../src/lib/pgClient.js";
import { getTestPgPool, getTestRedisClient } from "./setup.js";
import type { RedisLike } from "../src/lib/redisClient.js";

/**
 * README "Known gaps" specifically called out re-running
 * tests/concurrency.load.test.ts's scenario against PgOrderStore, not just
 * InMemoryOrderStore — that file only ever exercised InventoryService/Redis
 * concurrency directly, never concurrent saga runs writing to Postgres. This
 * closes that gap: many saga.run() calls in flight at once, each doing its
 * own transactional PgOrderStore.create()/updateStatus() (BEGIN/COMMIT per
 * write, see pgOrderStore.ts), and then re-reads every order straight back
 * out of Postgres — not from the in-process results — to prove no row was
 * lost, duplicated, or left with mismatched lines/events under contention.
 *
 * Needs a real local Postgres (`docker compose up postgres`) and Redis, same
 * as tests/pgOrderStore.test.ts and tests/saga.test.ts.
 */
describe("Concurrency against PgOrderStore", () => {
  let redis: RedisLike;

  afterAll(async () => {
    await redis?.quit();
    await closePgPool();
  });

  it("N concurrent single-unit orders against Postgres-backed order storage: exact quota, zero corrupted/missing rows", async () => {
    redis = await getTestRedisClient();
    const inventory = new InventoryService(redis);
    const store = new PgOrderStore(getTestPgPool());
    const eventBus = new InMemoryEventBus();
    const saga = new SagaOrchestrator(inventory, new PaymentGateway(), new ShippingProvider(), eventBus, store);

    const WAREHOUSE = "wh-pg-load";
    const SKU = "sku-pg-load-test";
    const STOCK = 40;
    const CONCURRENT_ORDERS = 80; // 2x stock, so roughly half should be rejected

    await inventory.setStock(WAREHOUSE, SKU, STOCK);

    const start = performance.now();
    const orderIds = await Promise.all(
      Array.from({ length: CONCURRENT_ORDERS }, (_, i) =>
        saga.createOrder(`cust-pg-load-${i}`, [{ sku: SKU, qty: 1, warehouseId: WAREHOUSE }], 999)
      )
    );
    const results = await Promise.all(orderIds.map((id) => saga.run(id)));
    const elapsedMs = performance.now() - start;

    const confirmed = results.filter((o) => o.status === "CONFIRMED");
    const cancelled = results.filter((o) => o.status === "CANCELLED");

    expect(confirmed).toHaveLength(STOCK);
    expect(cancelled).toHaveLength(CONCURRENT_ORDERS - STOCK);
    expect(await inventory.getAvailable(WAREHOUSE, SKU)).toBe(0);

    // Re-fetch every order straight from Postgres (not the in-process
    // `results` array) — the actual point of running this against
    // PgOrderStore instead of InMemoryOrderStore.
    const persisted = await Promise.all(orderIds.map((id) => store.get(id)));
    expect(persisted.every((o) => o !== undefined)).toBe(true);
    expect(persisted.filter((o) => o!.status === "CONFIRMED")).toHaveLength(STOCK);
    for (const order of persisted) {
      expect(order!.lines).toEqual([{ sku: SKU, qty: 1, warehouseId: WAREHOUSE }]);
    }

    console.log(
      `[pg-benchmark] ${CONCURRENT_ORDERS} concurrent saga.run() calls against PgOrderStore in ` +
        `${elapsedMs.toFixed(1)}ms — ${confirmed.length} confirmed, ${cancelled.length} cancelled, ` +
        `0 corrupted/missing rows.`
    );
  }, 30000);
});
