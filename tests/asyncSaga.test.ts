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

  it("createOrder() resolves while the order is still CREATED, before the saga has run", async () => {
    await inventory.setStock("wh-1", "sku-async-a", 10);
    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();
    const saga = new SagaOrchestrator(inventory, new PaymentGateway(), new ShippingProvider(), eventBus, store);
    wireAsyncSagaExecution(eventBus, saga);

    const orderId = await saga.createOrder("cust-async-1", [{ sku: "sku-async-a", qty: 1, warehouseId: "wh-1" }], 999);

    // Immediately after createOrder() resolves — before yielding the event
    // loop at all — the order must still be CREATED. If this were ever
    // CONFIRMED here, the subscriber would have blocked publish() on the
    // full saga run, exactly the synchronous-on-the-request-path behavior
    // this feature removes.
    const justCreated = await store.get(orderId);
    expect(justCreated!.status).toBe("CREATED");
    expect(justCreated!.history).toHaveLength(0);

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
