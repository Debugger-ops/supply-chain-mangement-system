import type { Order, OrderEvent, OrderId, OrderStatus } from "../types.js";

/**
 * Orders that have reached one of these are done for good — nothing else
 * ever moves them, and the startup recovery sweep (buildOrderStore's
 * caller in api/server.ts, via SagaOrchestrator.recoverStuck) treats every
 * other status as evidence the process died mid-saga.
 */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "CONFIRMED",
  "CANCELLED",
  "FAILED",
]);

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}

/**
 * Minimal persistence interface. InMemoryOrderStore is used by tests and the
 * sandbox verification script; PgOrderStore (schema in docs/schema.sql) is
 * the production implementation over Postgres — swap via ORDER_STORE=pg.
 *
 * businessId scoping (get/all): pass the requesting business's id to get
 * only orders that belong to it, or `null` to get only the shared
 * anonymous/demo pool (orders created without a session). Pass nothing
 * (undefined) for the internal, unscoped view the saga orchestrator and the
 * recovery sweep need — those operate on an order regardless of which
 * tenant owns it, since ownership is an HTTP-layer concern, not a
 * saga-correctness one. See src/api/routes/orders.ts for where the HTTP
 * layer applies the scoping.
 */
export interface OrderStore {
  create(order: Order): Promise<void>;
  get(id: OrderId, businessId?: string | null): Promise<Order | undefined>;
  updateStatus(id: OrderId, status: OrderStatus, event: OrderEvent): Promise<void>;
  all(businessId?: string | null): Promise<Order[]>;
  /** Every order not yet in a terminal status — what the startup recovery sweep scans. */
  nonTerminal(): Promise<Order[]>;
}

export class InMemoryOrderStore implements OrderStore {
  private orders = new Map<OrderId, Order>();

  async create(order: Order): Promise<void> {
    this.orders.set(order.id, order);
  }

  async get(id: OrderId, businessId?: string | null): Promise<Order | undefined> {
    const order = this.orders.get(id);
    if (!order) return undefined;
    if (businessId !== undefined && order.businessId !== businessId) return undefined;
    return order;
  }

  async updateStatus(id: OrderId, status: OrderStatus, event: OrderEvent): Promise<void> {
    const order = this.orders.get(id);
    if (!order) throw new Error(`Unknown order ${id}`);
    order.status = status;
    order.history.push(event);
    order.updatedAt = Date.now();
  }

  async all(businessId?: string | null): Promise<Order[]> {
    const all = [...this.orders.values()];
    if (businessId === undefined) return all;
    return all.filter((o) => o.businessId === businessId);
  }

  async nonTerminal(): Promise<Order[]> {
    return [...this.orders.values()].filter((o) => !isTerminalStatus(o.status));
  }
}
