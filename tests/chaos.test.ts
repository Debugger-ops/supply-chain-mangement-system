import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { InMemoryEventBus } from "../src/lib/eventBus.js";
import { PgOrderStore } from "../src/orders/pgOrderStore.js";
import { SagaOrchestrator } from "../src/orders/sagaOrchestrator.js";
import { recoverStuckOrders } from "../src/orders/recoverStuckOrders.js";
import { PaymentGateway } from "../src/payments/paymentGateway.js";
import { ShippingProvider } from "../src/shipping/shippingProvider.js";
import { closePgPool } from "../src/lib/pgClient.js";
import { getTestPgPool, getTestRedisClient } from "./setup.js";
import type { RedisLike } from "../src/lib/redisClient.js";

/**
 * True chaos/fault-injection test: spawns scripts/chaos/crash-mid-saga.ts as
 * a real child process, lets it reserve inventory and durably record
 * INVENTORY_RESERVED in Postgres, then SIGKILLs it — no graceful shutdown,
 * no chance to run cleanup — and verifies the startup recovery sweep
 * (src/orders/recoverStuckOrders.ts) finds that stuck order on a fresh
 * process and cleanly rolls it back. This is the actual "kill the process
 * mid-saga and verify recovery on restart" scenario the README's "Known
 * gaps" called out as missing; tests/recovery.test.ts covers the same
 * recovery logic at unit level without paying for a subprocess each time.
 *
 * Needs a real local Postgres (`docker compose up postgres`) and Redis, same
 * as tests/pgOrderStore.test.ts and tests/saga.test.ts.
 */
describe("Chaos: process killed mid-saga", () => {
  let redis: RedisLike;

  afterAll(async () => {
    await redis?.quit();
    await closePgPool();
  });

  function runChaosScript(sku: string, warehouseId: string, qty: number): Promise<{ orderId: string }> {
    return new Promise((resolve, reject) => {
      const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
      const child = spawn(tsxBin, ["scripts/chaos/crash-mid-saga.ts", sku, warehouseId, String(qty)], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

      child.on("error", reject);
      child.on("close", (code, signal) => {
        const orderId = stdout.trim().split("\n")[0];
        if (!orderId) {
          reject(new Error(`chaos script produced no order id (code=${code}, signal=${signal}): ${stderr}`));
          return;
        }
        // The whole point: this process must have been killed, not exited
        // cleanly — otherwise this test would just be exercising a normal
        // process.exit(), not an actual crash.
        expect(signal).toBe("SIGKILL");
        resolve({ orderId });
      });
    });
  }

  it("a killed process leaves the order INVENTORY_RESERVED and stock reduced; recovery cleanly rolls it back", async () => {
    redis = await getTestRedisClient();
    const inventory = new InventoryService(redis);
    const store = new PgOrderStore(getTestPgPool());

    const SKU = "sku-chaos-1";
    const WAREHOUSE = "wh-chaos";
    const QTY = 4;
    await inventory.setStock(WAREHOUSE, SKU, 10);

    const { orderId } = await runChaosScript(SKU, WAREHOUSE, QTY);

    // Confirm the crash really did leave things stuck: order recorded as
    // INVENTORY_RESERVED, and Redis stock genuinely reduced — nothing rolled
    // back on its own just because the process died.
    const stuck = await store.get(orderId);
    expect(stuck).toBeDefined();
    expect(stuck!.status).toBe("INVENTORY_RESERVED");
    expect(await inventory.getAvailable(WAREHOUSE, SKU)).toBe(6);

    // A fresh saga/store — standing in for the next process's startup —
    // runs the same recovery sweep api/server.ts runs automatically.
    const saga = new SagaOrchestrator(inventory, new PaymentGateway(), new ShippingProvider(), new InMemoryEventBus(), store);
    const recoveredCount = await recoverStuckOrders(store, saga);
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    const recovered = await store.get(orderId);
    expect(recovered!.status).toBe("CANCELLED");
    expect(recovered!.history.map((h) => h.type)).toContain("order.compensating");
    expect(await inventory.getAvailable(WAREHOUSE, SKU)).toBe(10); // fully released, nothing leaked

    // Idempotency: a second "restart" finds nothing left to recover for
    // this order and doesn't touch it again.
    const secondPass = await recoverStuckOrders(store, saga);
    const stillCancelled = await store.get(orderId);
    expect(stillCancelled).toEqual(recovered);
    void secondPass;
  }, 30000);
});
