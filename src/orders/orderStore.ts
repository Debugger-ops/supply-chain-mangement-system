import type { Order, OrderEvent, OrderId, OrderStatus } from "../types.js";

/**
 * Minimal persistence interface. InMemoryOrderStore is used by tests and the
 * sandbox verification script; PgOrderStore (schema in docs/schema.sql) is
 * the production implementation over Postgres — swap via ORDER_STORE=pg.
 */
export interface OrderStore {
  create(order: Order): Promise<void>;
  get(id: OrderId): Promise<Order | undefined>;
  updateStatus(id: OrderId, status: OrderStatus, event: OrderEvent): Promise<void>;
  all(): Promise<Order[]>;
}

export class InMemoryOrderStore implements OrderStore {
  private orders = new Map<OrderId, Order>();

  async create(order: Order): Promise<void> {
    this.orders.set(order.id, order);
  }

  async get(id: OrderId): Promise<Order | undefined> {
    return this.orders.get(id);
  }

  async updateStatus(id: OrderId, status: OrderStatus, event: OrderEvent): Promise<void> {
    const order = this.orders.get(id);
    if (!order) throw new Error(`Unknown order ${id}`);
    order.status = status;
    order.history.push(event);
    order.updatedAt = Date.now();
  }

  async all(): Promise<Order[]> {
    return [...this.orders.values()];
  }
}
