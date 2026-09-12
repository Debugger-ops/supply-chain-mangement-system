import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { InMemoryEventBus } from "../src/lib/eventBus.js";
import { InMemoryOrderStore } from "../src/orders/orderStore.js";
import { SagaOrchestrator } from "../src/orders/sagaOrchestrator.js";
import { PaymentGateway } from "../src/payments/paymentGateway.js";
import { ShippingProvider } from "../src/shipping/shippingProvider.js";
import { getTestRedisClient } from "./setup.js";
import type { RedisLike } from "../src/lib/redisClient.js";

describe("SagaOrchestrator", () => {
  let redis: RedisLike;
  let inventory: InventoryService;

  beforeEach(async () => {
    redis = await getTestRedisClient();
    inventory = new InventoryService(redis);
  });

  afterAll(async () => {
    await redis?.quit();
  });

  function buildSaga(opts: { failPayment?: string[]; failShipping?: string[] } = {}) {
    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();
    const payments = new PaymentGateway({ failPaymentForOrderIds: new Set(opts.failPayment) });
    const shipping = new ShippingProvider({ failShippingForOrderIds: new Set(opts.failShipping) });
    const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);
    return { saga, eventBus, store, payments, shipping };
  }

  it("runs the happy path to CONFIRMED and commits the reservation", async () => {
    await inventory.setStock("wh-1", "sku-happy", 10);
    const { saga } = buildSaga();

    const orderId = await saga.createOrder("cust-1", [{ sku: "sku-happy", qty: 2, warehouseId: "wh-1" }], 4999);
    const order = await saga.run(orderId);

    expect(order.status).toBe("CONFIRMED");
    expect(order.history.map((h) => h.type)).toEqual([
      "order.inventory_reserved",
      "order.payment_charged",
      "order.shipping_scheduled",
      "order.confirmed",
    ]);
    expect(await inventory.getAvailable("wh-1", "sku-happy")).toBe(8);
  });

  it("cancels and releases inventory when stock is insufficient", async () => {
    await inventory.setStock("wh-1", "sku-oos", 1);
    const { saga } = buildSaga();

    const orderId = await saga.createOrder("cust-1", [{ sku: "sku-oos", qty: 5, warehouseId: "wh-1" }], 4999);
    const order = await saga.run(orderId);

    expect(order.status).toBe("CANCELLED");
    expect(await inventory.getAvailable("wh-1", "sku-oos")).toBe(1); // untouched — reservation never happened
  });

  it("compensates (releases inventory, no charge) when payment fails", async () => {
    await inventory.setStock("wh-1", "sku-pay-fail", 10);

    // We need the real orderId to target the failure, so create it first.
    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();
    const payments = new PaymentGateway();
    const shipping = new ShippingProvider();
    const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);

    const orderId = await saga.createOrder("cust-2", [{ sku: "sku-pay-fail", qty: 3, warehouseId: "wh-1" }], 9999);
    (payments as unknown as { failureInjection: { failPaymentForOrderIds: Set<string> } })
      .failureInjection.failPaymentForOrderIds = new Set([orderId]);

    const before = await inventory.getAvailable("wh-1", "sku-pay-fail");
    const order = await saga.run(orderId);
    const after = await inventory.getAvailable("wh-1", "sku-pay-fail");

    expect(order.status).toBe("CANCELLED");
    expect(order.history.map((h) => h.type)).toContain("order.compensating");
    expect(after).toBe(before); // fully released, nothing leaked
  });

  it("compensates (refunds payment, releases inventory) when shipping fails", async () => {
    await inventory.setStock("wh-1", "sku-ship-fail", 10);

    const eventBus = new InMemoryEventBus();
    const store = new InMemoryOrderStore();
    const payments = new PaymentGateway();
    const shipping = new ShippingProvider();
    const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);

    const orderId = await saga.createOrder("cust-3", [{ sku: "sku-ship-fail", qty: 4, warehouseId: "wh-1" }], 14999);
    (shipping as unknown as { failureInjection: { failShippingForOrderIds: Set<string> } })
      .failureInjection.failShippingForOrderIds = new Set([orderId]);

    const before = await inventory.getAvailable("wh-1", "sku-ship-fail");
    const order = await saga.run(orderId);
    const after = await inventory.getAvailable("wh-1", "sku-ship-fail");

    expect(order.status).toBe("CANCELLED");
    expect(order.history.map((h) => h.type)).toContain("order.compensating");
    expect(after).toBe(before);
  });

  it("publishes every transition to the event bus in order", async () => {
    await inventory.setStock("wh-1", "sku-events", 10);
    const { saga, eventBus } = buildSaga();

    const orderId = await saga.createOrder("cust-4", [{ sku: "sku-events", qty: 1, warehouseId: "wh-1" }], 999);
    await saga.run(orderId);

    const types = eventBus.history("orders").map((e) => e.type);
    expect(types).toEqual([
      "order.created",
      "order.inventory_reserved",
      "order.payment_charged",
      "order.shipping_scheduled",
      "order.confirmed",
    ]);
  });
});
