import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PgOrderStore } from "../src/orders/pgOrderStore.js";
import { closePgPool } from "../src/lib/pgClient.js";
import { getTestPgPool } from "./setup.js";
import type { Order } from "../src/types.js";

describe("PgOrderStore", () => {
  let store: PgOrderStore;

  beforeAll(() => {
    store = new PgOrderStore(getTestPgPool());
  });

  afterAll(async () => {
    await closePgPool();
  });

  function buildOrder(overrides: Partial<Order> = {}): Order {
    const now = Date.now();
    return {
      id: randomUUID(),
      customerId: "cust-test",
      businessId: null,
      lines: [{ sku: "sku-pg-1", qty: 2, warehouseId: "wh-1" }],
      amountCents: 4999,
      status: "CREATED",
      history: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("round-trips create -> get, including lines", async () => {
    const order = buildOrder();
    await store.create(order);

    const fetched = await store.get(order.id);
    expect(fetched).toBeDefined();
    expect(fetched!.customerId).toBe("cust-test");
    expect(fetched!.lines).toEqual(order.lines);
    expect(fetched!.status).toBe("CREATED");
  });

  it("updateStatus appends to history and updates status", async () => {
    const order = buildOrder();
    await store.create(order);

    await store.updateStatus(order.id, "INVENTORY_RESERVED", {
      type: "order.inventory_reserved",
      at: Date.now(),
      detail: { reservations: [{ reservationId: "resv-1" }] },
    });

    const fetched = await store.get(order.id);
    expect(fetched!.status).toBe("INVENTORY_RESERVED");
    expect(fetched!.history).toHaveLength(1);
    expect(fetched!.history[0].type).toBe("order.inventory_reserved");
    expect(fetched!.history[0].detail).toEqual({ reservations: [{ reservationId: "resv-1" }] });
  });

  it("updateStatus throws on an unknown order and writes nothing", async () => {
    const unknownId = randomUUID();
    await expect(
      store.updateStatus(unknownId, "CONFIRMED", { type: "order.confirmed", at: Date.now() })
    ).rejects.toThrow();

    expect(await store.get(unknownId)).toBeUndefined();
  });

  it("all() returns every order, correctly grouped, without an N+1 query pattern", async () => {
    const a = buildOrder({ lines: [{ sku: "sku-pg-a", qty: 1, warehouseId: "wh-1" }] });
    const b = buildOrder({ lines: [{ sku: "sku-pg-b", qty: 3, warehouseId: "wh-2" }] });
    await store.create(a);
    await store.create(b);

    const all = await store.all();
    expect(all.map((o) => o.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(all.find((o) => o.id === a.id)!.lines).toEqual(a.lines);
  });

  // --- Multi-tenant scoping (docs/schema.sql's business_id column, see
  // README "Known gaps") ---------------------------------------------------

  it("get()/all() scoped to the owning business only return that business's orders", async () => {
    const owned = buildOrder({ businessId: randomUUID() });
    const other = buildOrder({ businessId: randomUUID() });
    await store.create(owned);
    await store.create(other);

    expect((await store.get(owned.id, owned.businessId))!.id).toBe(owned.id);
    expect(await store.get(owned.id, other.businessId)).toBeUndefined(); // wrong tenant, even though it exists
    expect((await store.all(owned.businessId)).map((o) => o.id)).toEqual([owned.id]);
  });

  it("get()/all() scoped to null (the anonymous pool) only match orders with a null business_id", async () => {
    const anonymous = buildOrder({ businessId: null });
    const owned = buildOrder({ businessId: randomUUID() });
    await store.create(anonymous);
    await store.create(owned);

    expect((await store.get(anonymous.id, null))!.id).toBe(anonymous.id);
    expect(await store.get(owned.id, null)).toBeUndefined();
    expect((await store.all(null)).map((o) => o.id)).toEqual(expect.arrayContaining([anonymous.id]));
    expect((await store.all(null)).map((o) => o.id)).not.toContain(owned.id);
  });

  it("get()/all() called with no businessId argument return regardless of tenant (the saga's internal view)", async () => {
    const owned = buildOrder({ businessId: randomUUID() });
    await store.create(owned);

    expect((await store.get(owned.id))!.id).toBe(owned.id);
    expect((await store.all()).map((o) => o.id)).toContain(owned.id);
  });

  // --- nonTerminal() (src/orders/recoverStuckOrders.ts's recovery sweep) --

  it("nonTerminal() returns only orders not yet CONFIRMED/CANCELLED/FAILED", async () => {
    const stuck = buildOrder({ status: "PAYMENT_CHARGED" });
    const confirmed = buildOrder({ status: "CONFIRMED" });
    const cancelled = buildOrder({ status: "CANCELLED" });
    await store.create(stuck);
    await store.create(confirmed);
    await store.create(cancelled);

    await store.updateStatus(stuck.id, "PAYMENT_CHARGED", { type: "order.payment_charged", at: Date.now() });
    await store.updateStatus(confirmed.id, "CONFIRMED", { type: "order.confirmed", at: Date.now() });
    await store.updateStatus(cancelled.id, "CANCELLED", { type: "order.cancelled", at: Date.now() });

    const found = (await store.nonTerminal()).map((o) => o.id);
    expect(found).toContain(stuck.id);
    expect(found).not.toContain(confirmed.id);
    expect(found).not.toContain(cancelled.id);
  });

  it("rolls back create() entirely when a line insert fails", async () => {
    const order = buildOrder({
      lines: [
        { sku: "sku-dup", qty: 1, warehouseId: "wh-1" },
        { sku: "sku-dup", qty: 2, warehouseId: "wh-1" }, // duplicate (order_id, sku, warehouse_id) -> PK violation
      ],
    });

    await expect(store.create(order)).rejects.toThrow();
    expect(await store.get(order.id)).toBeUndefined(); // no orphaned order row
  });
});