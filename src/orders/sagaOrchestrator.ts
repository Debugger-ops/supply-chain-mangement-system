import { randomUUID } from "node:crypto";
import type { InventoryService } from "../inventory/inventoryService.js";
import type { PaymentGateway } from "../payments/paymentGateway.js";
import type { ShippingProvider } from "../shipping/shippingProvider.js";
import type { EventBus } from "../lib/eventBus.js";
import type { OrderStore } from "./orderStore.js";
import { isTerminalStatus } from "./orderStore.js";
import type { Order, OrderId, OrderLine } from "../types.js";
import { metrics } from "../metrics/metrics.js";

const ORDERS_TOPIC = "orders";

/**
 * Orchestrates order fulfillment as a saga: a sequence of local transactions
 * (reserve inventory -> charge payment -> schedule shipping -> confirm),
 * each of which publishes an event, with an explicit compensating action for
 * every step that can partially succeed. If any step fails, already-completed
 * steps are unwound in reverse order — so a payment decline after inventory
 * was reserved releases that inventory instead of leaking it, and a shipping
 * failure after payment succeeded triggers a refund instead of charging a
 * customer for an order that never ships.
 *
 * This is the orchestration-style saga (one coordinator calling each
 * participant) rather than choreography (services reacting to each other's
 * events with no central coordinator) — orchestration trades some coupling
 * for a saga history that's trivial to audit and reason about, which is the
 * right trade for a single order-fulfillment flow like this one.
 *
 * Execution is asynchronous from the caller's point of view: createOrder()
 * only persists the order and publishes order.created — it does not run the
 * saga. api/server.ts wires a dedicated event-bus subscriber
 * (orders/asyncSagaRunner.ts's wireAsyncSagaExecution) that calls run() in
 * response to that event, off the request path, so POST /api/orders can
 * respond as soon as the order exists instead of blocking on payment/
 * shipping. Tests and scripts/verify.ts that want the old fully-synchronous
 * behavior just call createOrder() then run() directly, as before.
 */
export class SagaOrchestrator {
  constructor(
    private inventory: InventoryService,
    private payments: PaymentGateway,
    private shipping: ShippingProvider,
    private eventBus: EventBus,
    private store: OrderStore
  ) {}

  async createOrder(
    customerId: string,
    lines: OrderLine[],
    amountCents: number,
    businessId: string | null = null
  ): Promise<OrderId> {
    const order: Order = {
      id: randomUUID(),
      customerId,
      businessId,
      lines,
      amountCents,
      status: "CREATED",
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.store.create(order);
    await this.publish(order.id, "order.created", { customerId, lines, amountCents, businessId });
    return order.id;
  }

  /** Runs the full saga to completion (or to a clean rollback). */
  async run(orderId: OrderId): Promise<Order> {
    const order = await this.mustGet(orderId);
    const reservations: Array<{ warehouseId: string; sku: string; reservationId: string }> = [];

    // --- Step 1: reserve inventory for every line -------------------------
    for (const line of order.lines) {
      const result = await this.inventory.reserve(line.warehouseId, line.sku, line.qty);
      if (!result.ok) {
        await this.compensate(order, reservations, { paid: false, shipped: false });
        await this.fail(order.id, "INVENTORY_UNAVAILABLE", { sku: line.sku, warehouseId: line.warehouseId });
        return this.mustGet(orderId);
      }
      reservations.push({ warehouseId: line.warehouseId, sku: line.sku, reservationId: result.reservationId! });
    }
    await this.transition(order.id, "INVENTORY_RESERVED", "order.inventory_reserved", { reservations });

    // --- Step 2: charge payment --------------------------------------------
    const payment = await this.payments.charge(order.id, order.amountCents);
    if (!payment.ok) {
      await this.compensate(order, reservations, { paid: false, shipped: false });
      await this.fail(order.id, "PAYMENT_FAILED", { reason: payment.reason });
      return this.mustGet(orderId);
    }
    await this.transition(order.id, "PAYMENT_CHARGED", "order.payment_charged", { paymentId: payment.paymentId });

    // --- Step 3: schedule shipping ------------------------------------------
    const primaryWarehouse = order.lines[0]?.warehouseId ?? "unknown";
    const shipment = await this.shipping.schedule(order.id, primaryWarehouse);
    if (!shipment.ok) {
      await this.compensate(order, reservations, { paid: true, shipped: false });
      await this.fail(order.id, "SHIPPING_FAILED", { reason: shipment.reason });
      return this.mustGet(orderId);
    }
    await this.transition(order.id, "SHIPPING_SCHEDULED", "order.shipping_scheduled", { shipmentId: shipment.shipmentId });

    // --- Step 4: confirm — commit reservations permanently ------------------
    for (const r of reservations) {
      await this.inventory.commit(r.warehouseId, r.sku, r.reservationId);
    }
    await this.transition(order.id, "CONFIRMED", "order.confirmed", {});

    return this.mustGet(orderId);
  }

  /**
   * Recovery path for an order a crashed process left mid-saga (see
   * api/server.ts's startup recovery sweep and tests/chaos.test.ts). We
   * never try to resume forward from wherever the saga stopped — there's no
   * way to know, from persisted state alone, whether an in-flight payment or
   * shipping call actually landed on the other side before the crash. The
   * only response that's safe regardless is the one this whole saga is
   * built around: unwind whatever the order's history proves already
   * happened, via the same compensate() every other failure path uses,
   * which is idempotent by construction (release.lua, PaymentGateway.refund)
   * so it's safe even if a step had already partially compensated before
   * the crash that interrupted THIS recovery attempt.
   *
   * A no-op for an order already in a terminal status.
   */
  async recoverStuck(order: Order): Promise<Order> {
    if (isTerminalStatus(order.status)) return order;

    const reservations = this.reservationsFromHistory(order);
    const completed = {
      paid: order.history.some((h) => h.type === "order.payment_charged"),
      shipped: order.history.some((h) => h.type === "order.shipping_scheduled"),
    };
    await this.compensate(order, reservations, completed);
    await this.fail(order.id, "RECOVERED_AFTER_RESTART", { previousStatus: order.status });
    return this.mustGet(order.id);
  }

  private reservationsFromHistory(order: Order): Array<{ warehouseId: string; sku: string; reservationId: string }> {
    const reservedEvent = order.history.find((h) => h.type === "order.inventory_reserved");
    const reservations = reservedEvent?.detail?.reservations as
      | Array<{ warehouseId: string; sku: string; reservationId: string }>
      | undefined;
    return reservations ?? [];
  }

  /**
   * Compensating transactions, run in reverse order of what actually
   * succeeded. Every compensation call is idempotent (see release.lua and
   * PaymentGateway.refund), so re-running compensate() after a crash
   * mid-rollback is safe.
   */
  private async compensate(
    order: Order,
    reservations: Array<{ warehouseId: string; sku: string; reservationId: string }>,
    completed: { paid: boolean; shipped: boolean }
  ) {
    await this.transition(order.id, "COMPENSATING", "order.compensating", {});

    if (completed.shipped) {
      await this.shipping.cancel(order.id);
    }
    if (completed.paid) {
      await this.payments.refund(order.id);
    }
    for (const r of reservations) {
      await this.inventory.release(r.warehouseId, r.sku, r.reservationId);
    }
  }

  private async fail(orderId: OrderId, reason: string, detail: Record<string, unknown>) {
    await this.transition(orderId, "CANCELLED", "order.cancelled", { reason, ...detail });
  }

  private async transition(orderId: OrderId, status: Order["status"], eventType: string, detail: Record<string, unknown>) {
    const event = { type: eventType, at: Date.now(), detail };
    await this.store.updateStatus(orderId, status, event);
    await this.publish(orderId, eventType, detail);
    if (status === "CONFIRMED" || status === "CANCELLED") {
      metrics.sagaOutcomes.inc({ status });
    }
  }

  private async publish(orderId: OrderId, type: string, payload: Record<string, unknown>) {
    await this.eventBus.publish(ORDERS_TOPIC, { type, payload: { orderId, ...payload }, at: Date.now(), key: orderId });
  }

  private async mustGet(id: OrderId): Promise<Order> {
    const order = await this.store.get(id);
    if (!order) throw new Error(`Unknown order ${id}`);
    return order;
  }
}

export { ORDERS_TOPIC };
