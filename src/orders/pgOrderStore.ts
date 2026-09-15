import type { Pool } from "pg";
import type { Order, OrderEvent, OrderId, OrderLine, OrderStatus } from "../types.js";
import type { OrderStore } from "./orderStore.js";

interface OrderRow {
  id: string;
  customer_id: string;
  amount_cents: number;
  status: OrderStatus;
  created_at: Date;
  updated_at: Date;
}

interface OrderLineRow {
  order_id: string;
  sku: string;
  warehouse_id: string;
  qty: number;
}

interface OrderEventRow {
  order_id: string;
  type: string;
  detail: Record<string, unknown> | null;
  at: Date;
}

/**
 * Postgres-backed OrderStore (docs/schema.sql). Selected via ORDER_STORE=pg
 * in server.ts; InMemoryOrderStore remains the default and is what the test
 * suite uses unless a test explicitly opts into this store.
 *
 * create() and updateStatus() each write to two tables — every write here
 * runs inside an explicit transaction so a crash between the two inserts
 * can't leave the order and its lines/events out of sync.
 */
export class PgOrderStore implements OrderStore {
  constructor(private pool: Pool) {}

  async create(order: Order): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO orders (id, customer_id, amount_cents, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0))`,
        [order.id, order.customerId, order.amountCents, order.status, order.createdAt, order.updatedAt]
      );
      for (const line of order.lines) {
        await client.query(
          `INSERT INTO order_lines (order_id, sku, warehouse_id, qty) VALUES ($1, $2, $3, $4)`,
          [order.id, line.sku, line.warehouseId, line.qty]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async get(id: OrderId): Promise<Order | undefined> {
    const orderResult = await this.pool.query<OrderRow>(`SELECT * FROM orders WHERE id = $1`, [id]);
    const orderRow = orderResult.rows[0];
    if (!orderRow) return undefined;

    const [lines, history] = await Promise.all([this.linesFor([id]), this.eventsFor([id])]);
    return this.toOrder(orderRow, lines.get(id) ?? [], history.get(id) ?? []);
  }

  async updateStatus(id: OrderId, status: OrderStatus, event: OrderEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE orders SET status = $2, updated_at = to_timestamp($3 / 1000.0) WHERE id = $1`,
        [id, status, event.at]
      );
      if (result.rowCount === 0) {
        throw new Error(`Unknown order ${id}`);
      }
      await client.query(
        `INSERT INTO order_events (order_id, type, detail, at) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
        [id, event.type, event.detail ? JSON.stringify(event.detail) : null, event.at]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async all(): Promise<Order[]> {
    const orderResult = await this.pool.query<OrderRow>(`SELECT * FROM orders ORDER BY created_at ASC`);
    const ids = orderResult.rows.map((r) => r.id);
    if (ids.length === 0) return [];

    const [lines, history] = await Promise.all([this.linesFor(ids), this.eventsFor(ids)]);
    return orderResult.rows.map((row) => this.toOrder(row, lines.get(row.id) ?? [], history.get(row.id) ?? []));
  }

  // Batched fetch helpers: one query for N orders' lines, one for N orders'
  // events — never a per-order query in a loop.

  private async linesFor(orderIds: string[]): Promise<Map<string, OrderLine[]>> {
    const result = await this.pool.query<OrderLineRow>(
      `SELECT * FROM order_lines WHERE order_id = ANY($1::uuid[])`,
      [orderIds]
    );
    const byOrder = new Map<string, OrderLine[]>();
    for (const row of result.rows) {
      const list = byOrder.get(row.order_id) ?? [];
      list.push({ sku: row.sku, qty: row.qty, warehouseId: row.warehouse_id });
      byOrder.set(row.order_id, list);
    }
    return byOrder;
  }

  private async eventsFor(orderIds: string[]): Promise<Map<string, OrderEvent[]>> {
    const result = await this.pool.query<OrderEventRow>(
      `SELECT * FROM order_events WHERE order_id = ANY($1::uuid[]) ORDER BY at ASC, id ASC`,
      [orderIds]
    );
    const byOrder = new Map<string, OrderEvent[]>();
    for (const row of result.rows) {
      const list = byOrder.get(row.order_id) ?? [];
      list.push({ type: row.type, at: row.at.getTime(), detail: row.detail ?? undefined });
      byOrder.set(row.order_id, list);
    }
    return byOrder;
  }

  private toOrder(row: OrderRow, lines: OrderLine[], history: OrderEvent[]): Order {
    return {
      id: row.id,
      customerId: row.customer_id,
      lines,
      amountCents: row.amount_cents,
      status: row.status,
      history,
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    };
  }
}