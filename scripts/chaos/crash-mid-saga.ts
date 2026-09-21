// Chaos/fault-injection harness for tests/chaos.test.ts: simulates a process
// that crashes (SIGKILL — not a graceful exit) partway through a saga,
// right after the inventory reservation is durably recorded in Postgres but
// before payment is ever charged. This is a standalone script, spawned as a
// child process by the test — never imported directly — against real
// Postgres + Redis:
//
//   DATABASE_URL=... REDIS_HOST=... npx tsx scripts/chaos/crash-mid-saga.ts <sku> <warehouseId> [qty]
//
// Prints exactly one line to stdout — the created order's id — right before
// the crash, then kills the process with SIGKILL. A graceful process.exit()
// would only prove this code path runs; SIGKILL is what actually exercises
// "the process is gone with zero chance to run any cleanup," which is the
// specific failure mode the startup recovery sweep
// (src/orders/recoverStuckOrders.ts) exists to handle.

import { randomUUID } from "node:crypto";
import { RawRespClient } from "../../src/lib/redisClient.js";
import { InventoryService } from "../../src/inventory/inventoryService.js";
import { PgOrderStore } from "../../src/orders/pgOrderStore.js";
import { getPgPool } from "../../src/lib/pgClient.js";
import type { Order } from "../../src/types.js";

async function main() {
  const sku = process.argv[2];
  const warehouseId = process.argv[3];
  const qty = Number(process.argv[4] ?? "3");
  if (!sku || !warehouseId) {
    console.error("usage: crash-mid-saga.ts <sku> <warehouseId> [qty]");
    process.exit(2);
  }

  const redis = new RawRespClient(process.env.REDIS_HOST ?? "127.0.0.1", Number(process.env.REDIS_PORT ?? 6379));
  const inventory = new InventoryService(redis);
  const store = new PgOrderStore(getPgPool());

  const now = Date.now();
  const order: Order = {
    id: randomUUID(),
    customerId: "cust-chaos",
    businessId: null,
    lines: [{ sku, qty, warehouseId }],
    amountCents: 4999,
    status: "CREATED",
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  await store.create(order);

  // Step 1 of the saga, done for real: reserve inventory in Redis and
  // durably record it in Postgres — exactly what SagaOrchestrator.run()
  // does for this step, reproduced here (rather than calling the
  // orchestrator) so the crash lands at a precise, known point between
  // steps instead of somewhere inside one.
  const reservation = await inventory.reserve(warehouseId, sku, qty);
  if (!reservation.ok) {
    console.error(`reserve failed: ${reservation.reason}`);
    process.exit(3);
  }
  await store.updateStatus(order.id, "INVENTORY_RESERVED", {
    type: "order.inventory_reserved",
    at: Date.now(),
    detail: { reservations: [{ warehouseId, sku, reservationId: reservation.reservationId }] },
  });

  // The crash point. Write + a short delay so the pipe to the parent
  // process actually flushes before the signal lands (stdout writes to a
  // pipe are not guaranteed synchronous in Node) — then SIGKILL, which
  // can't be caught, ignored, or cleaned up after, unlike process.exit().
  process.stdout.write(order.id + "\n");
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
}

main().catch((err) => {
  console.error("chaos script failed before reaching the crash point:", err);
  process.exit(1);
});
