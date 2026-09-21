import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryOrderStore } from "../src/orders/orderStore.js";
import type { Order } from "../src/types.js";

// Pure OrderStore-level tests for multi-tenant scoping — no Redis/Postgres
// needed, since InMemoryOrderStore's get()/all() businessId filtering is
// plain in-process logic. tests/pgOrderStore.test.ts covers the same
// contract against the real Postgres implementation.
describe("OrderStore multi-tenant scoping (InMemoryOrderStore)", () => {
  function buildOrder(overrides: Partial<Order> = {}): Order {
    const now = Date.now();
    return {
      id: randomUUID(),
      customerId: "cust-mt",
      businessId: null,
      lines: [{ sku: "sku-mt", qty: 1, warehouseId: "wh-1" }],
      amountCents: 1999,
      status: "CREATED",
      history: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("get() with no businessId argument returns any order (the saga's internal view)", async () => {
    const store = new InMemoryOrderStore();
    const order = buildOrder({ businessId: "biz-a" });
    await store.create(order);

    expect(await store.get(order.id)).toEqual(order);
  });

  it("get() scoped to the owning business returns the order", async () => {
    const store = new InMemoryOrderStore();
    const order = buildOrder({ businessId: "biz-a" });
    await store.create(order);

    expect(await store.get(order.id, "biz-a")).toEqual(order);
  });

  it("get() scoped to a different business returns undefined, even though the order exists", async () => {
    const store = new InMemoryOrderStore();
    const order = buildOrder({ businessId: "biz-a" });
    await store.create(order);

    expect(await store.get(order.id, "biz-b")).toBeUndefined();
  });

  it("get() scoped to null (the anonymous pool) only matches orders with businessId null", async () => {
    const store = new InMemoryOrderStore();
    const anonymous = buildOrder({ businessId: null });
    const owned = buildOrder({ businessId: "biz-a" });
    await store.create(anonymous);
    await store.create(owned);

    expect(await store.get(anonymous.id, null)).toEqual(anonymous);
    expect(await store.get(owned.id, null)).toBeUndefined();
  });

  it("all() partitions cleanly across two businesses and the anonymous pool", async () => {
    const store = new InMemoryOrderStore();
    const a1 = buildOrder({ businessId: "biz-a" });
    const a2 = buildOrder({ businessId: "biz-a" });
    const b1 = buildOrder({ businessId: "biz-b" });
    const anon = buildOrder({ businessId: null });
    await Promise.all([store.create(a1), store.create(a2), store.create(b1), store.create(anon)]);

    expect((await store.all("biz-a")).map((o) => o.id).sort()).toEqual([a1.id, a2.id].sort());
    expect((await store.all("biz-b")).map((o) => o.id)).toEqual([b1.id]);
    expect((await store.all(null)).map((o) => o.id)).toEqual([anon.id]);
    expect(await store.all()).toHaveLength(4); // unscoped (internal) view sees everything
  });

  it("nonTerminal() finds every order not yet CONFIRMED/CANCELLED/FAILED, regardless of business", async () => {
    const store = new InMemoryOrderStore();
    const stuck = buildOrder({ businessId: "biz-a", status: "PAYMENT_CHARGED" });
    const confirmed = buildOrder({ businessId: "biz-a", status: "CONFIRMED" });
    const cancelled = buildOrder({ businessId: null, status: "CANCELLED" });
    await Promise.all([store.create(stuck), store.create(confirmed), store.create(cancelled)]);

    expect((await store.nonTerminal()).map((o) => o.id)).toEqual([stuck.id]);
  });
});
