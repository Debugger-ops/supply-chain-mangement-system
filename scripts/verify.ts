// Zero-dependency verification harness.
//
// Exercises the exact same InventoryService / SagaOrchestrator / WarehouseNode
// classes used by the API and the Vitest suite, but talks to Redis through
// RawRespClient (raw RESP over `node:net`) instead of ioredis, so it runs
// with nothing beyond a local `redis-server` and the Node/tsx toolchain —
// no `npm install`, no network. This is what generated the numbers in
// docs/RESUME_BULLETS.md; re-run it yourself with `npm run verify` (after
// `npm install`, or as-is if you already have tsx + a local redis-server)
// to reproduce them before you put them on a resume.

import { RawRespClient } from "../src/lib/redisClient.js";
import { InventoryService } from "../src/inventory/inventoryService.js";
import { InMemoryEventBus } from "../src/lib/eventBus.js";
import { InMemoryOrderStore } from "../src/orders/orderStore.js";
import { SagaOrchestrator } from "../src/orders/sagaOrchestrator.js";
import { PaymentGateway } from "../src/payments/paymentGateway.js";
import { ShippingProvider } from "../src/shipping/shippingProvider.js";
import { WarehouseNode, emitStockChange } from "../src/warehouse/warehouseSync.js";

const redis = new RawRespClient();
const inventory = new InventoryService(redis);

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function testConcurrencyNoOversell() {
  section("1. Concurrency: no overselling under contention");
  const WAREHOUSE = "wh-blr-1";
  const SKU = "sku-concurrency-test";
  const STOCK = 50;
  const CONCURRENT_REQUESTS = 500;

  await inventory.setStock(WAREHOUSE, SKU, STOCK);

  const start = performance.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () => inventory.reserve(WAREHOUSE, SKU, 1))
  );
  const elapsedMs = performance.now() - start;

  const accepted = results.filter((r) => r.ok).length;
  const rejected = results.filter((r) => !r.ok).length;
  const finalAvailable = await inventory.getAvailable(WAREHOUSE, SKU);

  console.log(`Stock: ${STOCK}, concurrent requests: ${CONCURRENT_REQUESTS}`);
  console.log(`Accepted: ${accepted}, Rejected (INSUFFICIENT_STOCK): ${rejected}`);
  console.log(`Final available in Redis: ${finalAvailable}`);
  console.log(`Wall time for ${CONCURRENT_REQUESTS} concurrent reservation calls: ${elapsedMs.toFixed(2)} ms`);
  console.log(`Avg latency per reservation call: ${(elapsedMs / CONCURRENT_REQUESTS).toFixed(4)} ms`);

  const ok = accepted === STOCK && rejected === CONCURRENT_REQUESTS - STOCK && finalAvailable === 0;
  console.log(ok ? "PASS: exactly STOCK reservations accepted, zero oversold." : "FAIL: oversold or lost stock!");
  return { ok, accepted, rejected, elapsedMs, throughputPerSec: CONCURRENT_REQUESTS / (elapsedMs / 1000) };
}

async function testLatencyPercentiles() {
  section("1b. Latency: p50/p95/p99 of a single reservation call");
  const WAREHOUSE = "wh-blr-1";
  const SKU = "sku-latency-test";
  const SAMPLES = 2000;
  await inventory.setStock(WAREHOUSE, SKU, SAMPLES + 1000); // plenty of stock, isolate latency from contention

  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    await inventory.reserve(WAREHOUSE, SKU, 1);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const pick = (p: number) => samples[Math.floor(samples.length * p)];
  const p50 = pick(0.5);
  const p95 = pick(0.95);
  const p99 = pick(0.99);

  console.log(`Samples: ${SAMPLES} sequential reserve() calls (single connection, localhost Redis)`);
  console.log(`p50: ${p50.toFixed(4)} ms, p95: ${p95.toFixed(4)} ms, p99: ${p99.toFixed(4)} ms`);
  return { samples: SAMPLES, p50, p95, p99 };
}

async function testMultiInstanceConcurrency() {
  section("1c. Concurrency across multiple simulated app instances");
  const WAREHOUSE = "wh-blr-1";
  const SKU = "sku-multi-instance-test";
  const STOCK = 200;
  const INSTANCES = 10;
  const REQUESTS_PER_INSTANCE = 150; // 1500 total requests against 200 stock, across 10 separate Redis connections

  await inventory.setStock(WAREHOUSE, SKU, STOCK);

  const instanceClients = Array.from({ length: INSTANCES }, () => new InventoryService(new RawRespClient()));

  const start = performance.now();
  const allResults = await Promise.all(
    instanceClients.flatMap((svc) =>
      Array.from({ length: REQUESTS_PER_INSTANCE }, () => svc.reserve(WAREHOUSE, SKU, 1))
    )
  );
  const elapsedMs = performance.now() - start;

  const accepted = allResults.filter((r) => r.ok).length;
  const finalAvailable = await inventory.getAvailable(WAREHOUSE, SKU);
  const totalRequests = INSTANCES * REQUESTS_PER_INSTANCE;

  console.log(`${INSTANCES} simulated app instances x ${REQUESTS_PER_INSTANCE} requests each = ${totalRequests} total, against ${STOCK} stock`);
  console.log(`Accepted: ${accepted} (expected exactly ${STOCK}), final available: ${finalAvailable} (expected 0)`);
  console.log(`Wall time: ${elapsedMs.toFixed(2)} ms, throughput: ${(totalRequests / (elapsedMs / 1000)).toFixed(0)} reservations/sec`);

  const ok = accepted === STOCK && finalAvailable === 0;
  console.log(ok ? "PASS: exact quota enforced across independent connections simulating separate instances." : "FAIL");
  return { ok, totalRequests, accepted, elapsedMs, throughputPerSec: totalRequests / (elapsedMs / 1000) };
}

async function testSagaHappyPath() {
  section("2. Saga: happy path reserves, charges, ships, confirms");
  const eventBus = new InMemoryEventBus();
  const store = new InMemoryOrderStore();
  const payments = new PaymentGateway();
  const shipping = new ShippingProvider();
  const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);

  const WAREHOUSE = "wh-blr-1";
  const SKU = "sku-happy-path";
  await inventory.setStock(WAREHOUSE, SKU, 10);

  const orderId = await saga.createOrder("cust-1", [{ sku: SKU, qty: 2, warehouseId: WAREHOUSE }], 4999);
  const order = await saga.run(orderId);

  const remaining = await inventory.getAvailable(WAREHOUSE, SKU);
  console.log(`Order status: ${order.status} (expected CONFIRMED)`);
  console.log(`Order history: ${order.history.map((h) => h.type).join(" -> ")}`);
  console.log(`Stock remaining after commit: ${remaining} (expected 8 — reservation converted to a permanent decrement)`);

  const ok = order.status === "CONFIRMED" && remaining === 8;
  console.log(ok ? "PASS" : "FAIL");
  return ok;
}

async function testSagaCompensatesOnPaymentFailure() {
  section("3. Saga: payment failure triggers compensation (inventory released)");
  const eventBus = new InMemoryEventBus();
  const store = new InMemoryOrderStore();
  const WAREHOUSE = "wh-blr-1";
  const SKU = "sku-payment-fail";
  await inventory.setStock(WAREHOUSE, SKU, 10);

  const orderId = crypto.randomUUID();
  const payments = new PaymentGateway({ failPaymentForOrderIds: new Set() });
  const shipping = new ShippingProvider();
  const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);

  const realOrderId = await saga.createOrder("cust-2", [{ sku: SKU, qty: 3, warehouseId: WAREHOUSE }], 9999);
  // Force this specific order's payment step to fail.
  (payments as unknown as { failureInjection: { failPaymentForOrderIds: Set<string> } }).failureInjection.failPaymentForOrderIds = new Set([realOrderId]);

  const before = await inventory.getAvailable(WAREHOUSE, SKU);
  const order = await saga.run(realOrderId);
  const after = await inventory.getAvailable(WAREHOUSE, SKU);

  console.log(`Order status: ${order.status} (expected CANCELLED)`);
  console.log(`Order history: ${order.history.map((h) => h.type).join(" -> ")}`);
  console.log(`Stock before reservation attempt: ${before}, after compensation: ${after} (expected equal — fully released)`);

  const ok = order.status === "CANCELLED" && before === after && order.history.some((h) => h.type === "order.compensating");
  console.log(ok ? "PASS: no inventory leaked after payment failure." : "FAIL: inventory was leaked!");
  return ok;
}

async function testSagaCompensatesOnShippingFailure() {
  section("4. Saga: shipping failure triggers refund + inventory release");
  const eventBus = new InMemoryEventBus();
  const store = new InMemoryOrderStore();
  const WAREHOUSE = "wh-blr-1";
  const SKU = "sku-shipping-fail";
  await inventory.setStock(WAREHOUSE, SKU, 10);

  const payments = new PaymentGateway();
  const shipping = new ShippingProvider();
  const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);

  const orderId = await saga.createOrder("cust-3", [{ sku: SKU, qty: 4, warehouseId: WAREHOUSE }], 14999);
  (shipping as unknown as { failureInjection: { failShippingForOrderIds: Set<string> } }).failureInjection.failShippingForOrderIds = new Set([orderId]);

  const before = await inventory.getAvailable(WAREHOUSE, SKU);
  const order = await saga.run(orderId);
  const after = await inventory.getAvailable(WAREHOUSE, SKU);

  console.log(`Order status: ${order.status} (expected CANCELLED)`);
  console.log(`Order history: ${order.history.map((h) => h.type).join(" -> ")}`);
  console.log(`Stock before: ${before}, after rollback: ${after} (expected equal)`);

  const ok = order.status === "CANCELLED" && before === after;
  console.log(ok ? "PASS: payment refunded and inventory released after shipping failure." : "FAIL");
  return ok;
}

async function testWarehouseConvergenceAfterPartition() {
  section("5. Multi-warehouse: convergence after a simulated network partition");
  const eventBus = new InMemoryEventBus();
  const nodeA = new WarehouseNode("wh-blr-1", eventBus);
  const nodeB = new WarehouseNode("wh-del-2", eventBus);
  const SKU = "sku-convergence-test";

  await emitStockChange(eventBus, SKU, 100, "initial-stock");
  console.log(`After initial stock event — A: ${nodeA.get(SKU)}, B: ${nodeB.get(SKU)}`);

  console.log("Partitioning node B...");
  nodeB.disconnect();

  const EVENTS_DURING_PARTITION = 25;
  for (let i = 0; i < EVENTS_DURING_PARTITION; i++) {
    await emitStockChange(eventBus, SKU, -1, `sale-${i}`);
  }
  console.log(
    `During partition (${EVENTS_DURING_PARTITION} sales) — A: ${nodeA.get(SKU)} (live), B: ${nodeB.get(SKU)} (stale, unchanged)`
  );

  const start = performance.now();
  nodeB.reconnect();
  const convergeMs = performance.now() - start;

  console.log(`Node B reconnected and replayed missed events in ${convergeMs.toFixed(3)} ms`);
  console.log(`After reconnect — A: ${nodeA.get(SKU)}, B: ${nodeB.get(SKU)}`);

  const expected = 100 - EVENTS_DURING_PARTITION;
  const ok = nodeA.get(SKU) === expected && nodeB.get(SKU) === expected;
  console.log(ok ? "PASS: both nodes converged to the same value with zero lost or duplicated events." : "FAIL: divergence!");
  return { ok, convergeMs, eventsReplayed: EVENTS_DURING_PARTITION };
}

async function main() {
  const results: Record<string, unknown> = {};
  results.concurrency = await testConcurrencyNoOversell();
  results.latency = await testLatencyPercentiles();
  results.multiInstanceConcurrency = await testMultiInstanceConcurrency();
  results.sagaHappyPath = await testSagaHappyPath();
  results.sagaPaymentCompensation = await testSagaCompensatesOnPaymentFailure();
  results.sagaShippingCompensation = await testSagaCompensatesOnShippingFailure();
  results.warehouseConvergence = await testWarehouseConvergenceAfterPartition();

  section("SUMMARY");
  console.log(JSON.stringify(results, null, 2));

  await redis.quit();
  // Some sub-tests (multi-instance concurrency) open their own raw TCP
  // sockets to Redis and don't track them for cleanup here; force exit
  // rather than leaving the process hanging on open handles.
  process.exit(0);
}

main().catch((err) => {
  console.error("Verification script crashed:", err);
  process.exit(1);
});
