import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { InMemoryEventBus } from "../src/lib/eventBus.js";
import { InMemoryOrderStore } from "../src/orders/orderStore.js";
import { SagaOrchestrator } from "../src/orders/sagaOrchestrator.js";
import { recoverStuckOrders } from "../src/orders/recoverStuckOrders.js";
import { PaymentGateway } from "../src/payments/paymentGateway.js";
import { ShippingProvider } from "../src/shipping/shippingProvider.js";
import { getTestRedisClient } from "./setup.js";
import type { RedisLike } from "../src/lib/redisClient.js";

// SagaOrchestrator.recoverStuck() / recoverStuckOrders() — the startup
// recovery sweep for an order a crashed process left mid-saga (README
// "Known gaps"). These drive the same InventoryService.release()/
// PaymentGateway.refund() paths every other compensation test uses, so they
// need the same real local Redis as saga.test.ts (see README "Running
// tests"). tests/chaos.test.ts covers the same behavior end-to-end through
// an actual killed process; these are the fast, deterministic unit-level
// checks of the recovery logic itself.
describe("SagaOrchestrator.recoverStuck", () => {
  let redis: RedisLike;
  let inventory: InventoryService;

  beforeEach(async () => {
    redis = await getTestRedisClient();
    inventory = new InventoryService(redis);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  function buildSaga() {
    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();
    const payments = new PaymentGateway();
    const shipping = new ShippingProvider();
    const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);
    return { saga, store, payments, shipping };
  }

  it("releases inventory and cancels an order stuck at INVENTORY_RESERVED", async () => {
    await inventory.setStock("wh-1", "sku-recover-a", 10);
    const { saga, store } = buildSaga();

    // Simulate a process that crashed right after the reservation step
    // committed to the store, but before it ever called payments.charge().
    const orderId = await saga.createOrder("cust-r1", [{ sku: "sku-recover-a", qty: 4, warehouseId: "wh-1" }], 4999);
    const reservation = await inventory.reserve("wh-1", "sku-recover-a", 4);
    expect(reservation.ok).toBe(true);
    await store.updateStatus(orderId, "INVENTORY_RESERVED", {
      type: "order.inventory_reserved",
      at: Date.now(),
      detail: { reservations: [{ warehouseId: "wh-1", sku: "sku-recover-a", reservationId: reservation.reservationId }] },
    });

    expect(await inventory.getAvailable("wh-1", "sku-recover-a")).toBe(6);

    const stuck = await store.get(orderId);
    const recovered = await saga.recoverStuck(stuck!);

    expect(recovered.status).toBe("CANCELLED");
    expect(recovered.history.map((h) => h.type)).toEqual(
      expect.arrayContaining(["order.compensating", "order.cancelled"])
    );
    expect(await inventory.getAvailable("wh-1", "sku-recover-a")).toBe(10); // fully released
  });

  it("refunds payment and releases inventory for an order stuck at PAYMENT_CHARGED", async () => {
    await inventory.setStock("wh-1", "sku-recover-b", 10);
    const { saga, store, payments } = buildSaga();

    const orderId = await saga.createOrder("cust-r2", [{ sku: "sku-recover-b", qty: 2, warehouseId: "wh-1" }], 9999);
    const reservation = await inventory.reserve("wh-1", "sku-recover-b", 2);
    await store.updateStatus(orderId, "INVENTORY_RESERVED", {
      type: "order.inventory_reserved",
      at: Date.now(),
      detail: { reservations: [{ warehouseId: "wh-1", sku: "sku-recover-b", reservationId: reservation.reservationId }] },
    });
    const payment = await payments.charge(orderId, 9999);
    expect(payment.ok).toBe(true);
    await store.updateStatus(orderId, "PAYMENT_CHARGED", {
      type: "order.payment_charged",
      at: Date.now(),
      detail: { paymentId: payment.paymentId },
    });

    const stuck = await store.get(orderId);
    const recovered = await saga.recoverStuck(stuck!);

    expect(recovered.status).toBe("CANCELLED");
    expect(await inventory.getAvailable("wh-1", "sku-recover-b")).toBe(10);
  });

  it("is a no-op for an order already in a terminal status", async () => {
    const { saga, store } = buildSaga();
    const orderId = await saga.createOrder("cust-r3", [{ sku: "sku-recover-c", qty: 1, warehouseId: "wh-1" }], 1999);
    await inventory.setStock("wh-1", "sku-recover-c", 5);
    const order = await saga.run(orderId); // runs to CONFIRMED

    const result = await saga.recoverStuck(order);
    expect(result).toEqual(order);
    expect((await store.get(orderId))!.history).toEqual(order.history); // nothing appended
  });

  it("recovering twice is safe (idempotent) — second pass is a no-op", async () => {
    await inventory.setStock("wh-1", "sku-recover-d", 10);
    const { saga, store } = buildSaga();

    const orderId = await saga.createOrder("cust-r4", [{ sku: "sku-recover-d", qty: 3, warehouseId: "wh-1" }], 4999);
    const reservation = await inventory.reserve("wh-1", "sku-recover-d", 3);
    await store.updateStatus(orderId, "INVENTORY_RESERVED", {
      type: "order.inventory_reserved",
      at: Date.now(),
      detail: { reservations: [{ warehouseId: "wh-1", sku: "sku-recover-d", reservationId: reservation.reservationId }] },
    });

    const stuck = await store.get(orderId);
    const first = await saga.recoverStuck(stuck!);
    expect(first.status).toBe("CANCELLED");
    expect(await inventory.getAvailable("wh-1", "sku-recover-d")).toBe(10);

    const second = await saga.recoverStuck(first); // already terminal now
    expect(second).toEqual(first);
    expect(await inventory.getAvailable("wh-1", "sku-recover-d")).toBe(10); // unchanged
  });

  it("recoverStuckOrders sweeps every non-terminal order in the store and leaves confirmed ones alone", async () => {
    await inventory.setStock("wh-1", "sku-recover-sweep-a", 10);
    await inventory.setStock("wh-1", "sku-recover-sweep-b", 10);
    const { saga, store } = buildSaga();

    // One order that completes normally...
    const okId = await saga.createOrder("cust-r5", [{ sku: "sku-recover-sweep-a", qty: 1, warehouseId: "wh-1" }], 999);
    await saga.run(okId);

    // ...and one left stuck, as if the process died after reserving.
    const stuckId = await saga.createOrder("cust-r6", [{ sku: "sku-recover-sweep-b", qty: 5, warehouseId: "wh-1" }], 2999);
    const reservation = await inventory.reserve("wh-1", "sku-recover-sweep-b", 5);
    await store.updateStatus(stuckId, "INVENTORY_RESERVED", {
      type: "order.inventory_reserved",
      at: Date.now(),
      detail: { reservations: [{ warehouseId: "wh-1", sku: "sku-recover-sweep-b", reservationId: reservation.reservationId }] },
    });

    const recoveredCount = await recoverStuckOrders(store, saga);
    expect(recoveredCount).toBe(1);

    expect((await store.get(okId))!.status).toBe("CONFIRMED");
    expect((await store.get(stuckId))!.status).toBe("CANCELLED");
    expect(await inventory.getAvailable("wh-1", "sku-recover-sweep-b")).toBe(10);
  });
});
