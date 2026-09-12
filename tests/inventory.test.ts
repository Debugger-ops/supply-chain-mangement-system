import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { getTestRedisClient } from "./setup.js";
import type { RedisLike } from "../src/lib/redisClient.js";

describe("InventoryService", () => {
  let redis: RedisLike;
  let inventory: InventoryService;

  beforeAll(async () => {
    redis = await getTestRedisClient();
    inventory = new InventoryService(redis);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("reserves stock and decrements availability", async () => {
    await inventory.setStock("wh-1", "sku-a", 10);
    const result = await inventory.reserve("wh-1", "sku-a", 3);
    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(7);
    expect(await inventory.getAvailable("wh-1", "sku-a")).toBe(7);
  });

  it("rejects reservations that exceed available stock", async () => {
    await inventory.setStock("wh-1", "sku-b", 5);
    const result = await inventory.reserve("wh-1", "sku-b", 6);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("INSUFFICIENT_STOCK");
    expect(await inventory.getAvailable("wh-1", "sku-b")).toBe(5); // unchanged
  });

  it("rejects non-positive quantities", async () => {
    await inventory.setStock("wh-1", "sku-c", 5);
    const result = await inventory.reserve("wh-1", "sku-c", 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("INVALID_QTY");
  });

  it("never oversells under 500 concurrent reservations against 50 units of stock", async () => {
    await inventory.setStock("wh-1", "sku-concurrency", 50);
    const results = await Promise.all(
      Array.from({ length: 500 }, () => inventory.reserve("wh-1", "sku-concurrency", 1))
    );
    const accepted = results.filter((r) => r.ok).length;
    expect(accepted).toBe(50);
    expect(await inventory.getAvailable("wh-1", "sku-concurrency")).toBe(0);
  });

  it("release() returns reserved stock to the available pool", async () => {
    await inventory.setStock("wh-1", "sku-d", 10);
    const result = await inventory.reserve("wh-1", "sku-d", 4);
    await inventory.release("wh-1", "sku-d", result.reservationId!);
    expect(await inventory.getAvailable("wh-1", "sku-d")).toBe(10);
  });

  it("commit() permanently consumes a reservation", async () => {
    await inventory.setStock("wh-1", "sku-e", 10);
    const result = await inventory.reserve("wh-1", "sku-e", 4);
    await inventory.commit("wh-1", "sku-e", result.reservationId!);
    // Stock stays decremented — commit does not restore it.
    expect(await inventory.getAvailable("wh-1", "sku-e")).toBe(6);
  });

  it("resolving the same reservation twice is a safe no-op (idempotent compensation)", async () => {
    await inventory.setStock("wh-1", "sku-f", 10);
    const result = await inventory.reserve("wh-1", "sku-f", 4);
    await inventory.release("wh-1", "sku-f", result.reservationId!);
    // Second release for the same (already-resolved) reservation must not
    // double-credit the stock back.
    await inventory.release("wh-1", "sku-f", result.reservationId!);
    expect(await inventory.getAvailable("wh-1", "sku-f")).toBe(10);
  });
});
