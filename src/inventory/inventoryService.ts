import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { RedisLike } from "../lib/redisClient.js";
import type { ReservationResult, Sku, WarehouseId } from "../types.js";
import { metrics } from "../metrics/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESERVE_SCRIPT = readFileSync(path.join(__dirname, "reserve.lua"), "utf8");
const RELEASE_SCRIPT = readFileSync(path.join(__dirname, "release.lua"), "utf8");

const DEFAULT_RESERVATION_TTL_SECONDS = 60 * 15; // auto-release if a saga never resolves

export interface KnownStockRecord {
  warehouseId: WarehouseId;
  sku: Sku;
  available: number;
}

/**
 * Distributed inventory reservation, safe under concurrent access from
 * multiple app instances, because the reserve/release paths run as single
 * atomic Lua scripts on the Redis server rather than as a
 * read-then-write from the client.
 *
 * This is the same pattern FlowGate uses for rate-limit decisions
 * (https://github.com/<you>/flowgate) applied to stock counts instead of
 * quota buckets.
 */
export class InventoryService {
  constructor(private redis: RedisLike) {}

  // Redis has no cheap "list all stock keys" primitive here (no SCAN in
  // RawRespClient), so the dashboard's inventory view is backed by this
  // small in-process registry of every (warehouseId, sku) pair this
  // process has ever touched. It's per-process and resets on restart —
  // fine for a single-instance dev/demo dashboard, not a substitute for a
  // real catalog service in production. See "Known gaps" in the README.
  private known = new Map<string, { warehouseId: WarehouseId; sku: Sku }>();

  private noteKnown(warehouseId: WarehouseId, sku: Sku): void {
    this.known.set(this.stockKey(warehouseId, sku), { warehouseId, sku });
  }

  stockKey(warehouseId: WarehouseId, sku: Sku): string {
    return `stock:${warehouseId}:${sku}`;
  }

  reservationKey(reservationId: string): string {
    return `resv:${reservationId}`;
  }

  async setStock(warehouseId: WarehouseId, sku: Sku, qty: number): Promise<void> {
    await this.redis.set(this.stockKey(warehouseId, sku), String(qty));
    this.noteKnown(warehouseId, sku);
  }

  async getAvailable(warehouseId: WarehouseId, sku: Sku): Promise<number> {
    const v = await this.redis.get(this.stockKey(warehouseId, sku));
    return v === null ? 0 : Number(v);
  }

  /** Every (warehouseId, sku) pair this process has seen, with its current available count. Powers the dashboard's inventory table. */
  async listAll(): Promise<KnownStockRecord[]> {
    const entries = [...this.known.values()];
    const records = await Promise.all(
      entries.map(async ({ warehouseId, sku }) => ({
        warehouseId,
        sku,
        available: await this.getAvailable(warehouseId, sku),
      }))
    );
    records.sort((a, b) => (a.warehouseId + a.sku).localeCompare(b.warehouseId + b.sku));
    return records;
  }

  /**
   * Atomically reserves `qty` units of `sku` at `warehouseId`. Returns
   * ok:false with reason INSUFFICIENT_STOCK if not enough stock is
   * available — this never oversells even when called concurrently from
   * many instances, because Redis executes the whole check-and-decrement
   * as one operation.
   */
  async reserve(
    warehouseId: WarehouseId,
    sku: Sku,
    qty: number,
    ttlSeconds = DEFAULT_RESERVATION_TTL_SECONDS
  ): Promise<ReservationResult> {
    if (qty <= 0) return { ok: false, reason: "INVALID_QTY" };
    this.noteKnown(warehouseId, sku);
    const reservationId = randomUUID();
    const start = performance.now();
    const result = (await this.redis.eval(
      RESERVE_SCRIPT,
      2,
      this.stockKey(warehouseId, sku),
      this.reservationKey(reservationId),
      qty,
      reservationId,
      ttlSeconds
    )) as [string, number];
    metrics.reservationLatency.observe(performance.now() - start);

    const [status, value] = result;
    if (status === "INSUFFICIENT_STOCK") {
      metrics.reservationsRejected.inc({ sku, warehouseId });
      return { ok: false, reason: "INSUFFICIENT_STOCK", remaining: value };
    }
    metrics.reservationsAccepted.inc({ sku, warehouseId });
    return { ok: true, reservationId, remaining: value };
  }

  private async resolve(warehouseId: WarehouseId, sku: Sku, reservationId: string, mode: "RELEASE" | "COMMIT") {
    const result = (await this.redis.eval(
      RELEASE_SCRIPT,
      2,
      this.stockKey(warehouseId, sku),
      this.reservationKey(reservationId),
      mode
    )) as [string, number];
    return result[0];
  }

  /** Compensating action: returns reserved stock to the available pool. */
  async release(warehouseId: WarehouseId, sku: Sku, reservationId: string): Promise<string> {
    return this.resolve(warehouseId, sku, reservationId, "RELEASE");
  }

  /** Permanently consumes a reservation once the order is confirmed. */
  async commit(warehouseId: WarehouseId, sku: Sku, reservationId: string): Promise<string> {
    return this.resolve(warehouseId, sku, reservationId, "COMMIT");
  }
}
