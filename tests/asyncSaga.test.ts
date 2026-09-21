import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { InMemoryEventBus } from "../src/lib/eventBus.js";
import { InMemoryOrderStore } from "../src/orders/orderStore.js";
import { SagaOrchestrator } from "../src/orders/sagaOrchestrator.js";
import { wireAsyncSagaExecution } from "../src/orders/asyncSagaRunner.js";
import { PaymentGateway } from "../src/payments/paymentGateway.js";
import { ShippingProvider } from "../src/shipping/shippingProvider.js";
import { getTestRedisClient } from "./setup.js";
import type { RedisLike } from "../src/lib/redisClient.js";

function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Proves the actual contract orders/asyncSagaRunner.ts and the new
// POST /api/orders behavior depend on: createOrder() returns before the
// saga has run at all, and the saga completes on its own afterward, driven
// by the wired event-bus subscriber rather than by the caller awaiting it.
describe("Async saga execution (wireAsyncSagaExecution)", () => {
  let redis: RedisLike;
  let inventory: InventoryService;

  beforeEach(async () => {
    redis = await getTestRedisClient();
    inventory = new InventoryService(redis);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  it("createOrder() resolves before the saga's first step ever runs, then the saga completes on its own", async () => {
    await inventory.setStock("wh-1", "sku-async-a", 10);
    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();

    // A real reservation call, real Redis round-trip included, is often
    // fast enough (especially against an in-process test double — see
    // tests/setup.ts's TEST_REDIS_DRIVER=memory) that createOrder()'s own
    // handful of microtasks and the fire-and-forget saga's first step can
    // race each other — a flaky thing to assert on either way. Gating
    // reserve() behind a real macrotask (setTimeout) instead of relying on
    // however fast the Redis backend happens to be makes the ordering
    // deterministic: createOrder() only ever needs microtasks to resolve,
    // so it is guaranteed to finish first regardless of backend speed.
    let reserveCalls = 0;
    class GatedInventoryService extends InventoryService {
      async reserve(...args: Parameters<InventoryService["reserve"]>) {
        reserveCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return super.reserve(...args);
      }
    }
    const gatedInventory = new GatedInventoryService(redis);
    await gatedInventory.setStock("wh-1", "sku-async-a", 10);

    const saga = new SagaOrchestrator(gatedInventory, new PaymentGateway(), new ShippingProvider(), eventBus, store);
    wireAsyncSagaExecution(eventBus, saga);

    const orderId = await saga.createOrder("cust-async-1", [{ sku: "sku-async-a", qty: 1, warehouseId: "wh-1" }], 999);

    // createOrder() has resolved, but the saga's very first step (the
    // gated reserve() above) has not been allowed to finish yet — proof
    // that the caller wasn't blocked on it. If wireAsyncSagaExecution ever
    // regressed to awaiting run() inline, this would fail: createOrder()
    // couldn't resolve until the 20ms gate opened.
    const justCreated = await store.get(orderId);
    expect(justCreated!.status).toBe("CREATED");
    expect(justCreated!.history).toHaveLength(0);
    expect(reserveCalls).toBeLessThanOrEqual(1); // 0 (not yet called) or 1 (called, still awaiting the gate)

    // ...but the saga does complete shortly after, on its own.
    await waitFor(() => eventBus.history("orders").some((e) => e.type === "order.confirmed"));
    const finished = await store.get(orderId);
    expect(finished!.status).toBe("CONFIRMED");
  });

  it("runs multiple orders concurrently without cross-talk", async () => {
    await inventory.setStock("wh-1", "sku-async-b", 5);
    await inventory.setStock("wh-1", "sku-async-c", 5);
    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();
    const saga = new SagaOrchestrator(inventory, new PaymentGateway(), new ShippingProvider(), eventBus, store);
    wireAsyncSagaExecution(eventBus, saga);

    const id1 = await saga.createOrder("cust-async-2", [{ sku: "sku-async-b", qty: 2, warehouseId: "wh-1" }], 1999);
    const id2 = await saga.createOrder("cust-async-3", [{ sku: "sku-async-c", qty: 3, warehouseId: "wh-1" }], 2999);

    await waitFor(
      () =>
        eventBus.history("orders").filter((e) => e.type === "order.confirmed").length === 2
    );

    expect((await store.get(id1))!.status).toBe("CONFIRMED");
    expect((await store.get(id2))!.status).toBe("CONFIRMED");
    expect(await inventory.getAvailable("wh-1", "sku-async-b")).toBe(3);
    expect(await inventory.getAvailable("wh-1", "sku-async-c")).toBe(2);
  });

  it("a saga failure (e.g. out-of-stock) still resolves to CANCELLED asynchronously, not silently", async () => {
    await inventory.setStock("wh-1", "sku-async-oos", 1);
    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();
    const saga = new SagaOrchestrator(inventory, new PaymentGateway(), new ShippingProvider(), eventBus, store);
    wireAsyncSagaExecution(eventBus, saga);

    const orderId = await saga.createOrder("cust-async-4", [{ sku: "sku-async-oos", qty: 5, warehouseId: "wh-1" }], 999);

    await waitFor(() => eventBus.history("orders").some((e) => e.type === "order.cancelled"));
    expect((await store.get(orderId))!.status).toBe("CANCELLED");
  });
});
