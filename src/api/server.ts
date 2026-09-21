import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type RedisLike } from "../lib/redisClient.js";
import { InMemoryEventBus, createKafkaEventBus, type EventBus } from "../lib/eventBus.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { connectRedis } from "../inventory/connectRedis.js";
import { PaymentGateway } from "../payments/paymentGateway.js";
import { ShippingProvider } from "../shipping/shippingProvider.js";
import { InMemoryOrderStore, type OrderStore } from "../orders/orderStore.js";
import { PgOrderStore } from "../orders/pgOrderStore.js";
import { InMemoryBusinessStore, type BusinessStore } from "../business/businessStore.js";
import { PgBusinessStore } from "../business/pgBusinessStore.js";
import { getPgPool } from "../lib/pgClient.js";
import { SagaOrchestrator } from "../orders/sagaOrchestrator.js";
import { wireAsyncSagaExecution } from "../orders/asyncSagaRunner.js";
import { recoverStuckOrders } from "../orders/recoverStuckOrders.js";
import { ordersRouter } from "./routes/orders.js";
import { businessRouter } from "./routes/business.js";
import { inventoryRouter } from "./routes/inventory.js";
import { metricsRouter } from "./routes/metrics.js";
import { SseHub } from "./sseHub.js";
import { metricsSnapshotText } from "../metrics/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function buildRedisClient(): Promise<RedisLike> {
  // See src/inventory/connectRedis.ts for the REDIS_DRIVER=ioredis/memory/
  // raw switch — shared with scripts/seed.ts so the two can't drift.
  return connectRedis();
}

async function buildEventBus(): Promise<EventBus> {
  const brokers = process.env.KAFKA_BROKERS;
  if (brokers) {
    return createKafkaEventBus(brokers.split(","), "supply-chain-saga");
  }
  return new InMemoryEventBus();
}

// ORDER_STORE=pg (recommended once DATABASE_URL points at a real Postgres —
// see .env.example / docker-compose.yml) persists orders in Postgres via
// PgOrderStore (docs/schema.sql), so order history survives a restart.
// Defaults to InMemoryOrderStore — same "raw unless opted in" pattern as
// REDIS_DRIVER above — which is also what the test suite uses unless a test
// explicitly opts into PgOrderStore.
function buildOrderStore(): OrderStore {
  if (process.env.ORDER_STORE === "pg") {
    return new PgOrderStore(getPgPool());
  }
  return new InMemoryOrderStore();
}

// Same ORDER_STORE=pg flag as buildOrderStore() above — it is the same
// Postgres instance (docs/schema.sql defines both the orders tables and
// businesses), so one flag is enough rather than a second env var to keep
// in sync with it.
function buildBusinessStore(): BusinessStore {
  if (process.env.ORDER_STORE === "pg") {
    return new PgBusinessStore(getPgPool());
  }
  return new InMemoryBusinessStore();
}

async function main() {
  const redis = await buildRedisClient();
  const eventBus = await buildEventBus();

  const inventory = new InventoryService(redis);
  const payments = new PaymentGateway();
  const shipping = new ShippingProvider();
  const store = buildOrderStore();
  const businessStore = buildBusinessStore();
  const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);

  // Drive the saga off the event bus instead of inline on the request path
  // (see orders/asyncSagaRunner.ts) — must be wired before anything can
  // publish order.created, i.e. before the HTTP routes below go live.
  wireAsyncSagaExecution(eventBus, saga);

  // Roll back any order a previous process left mid-saga (see
  // orders/recoverStuckOrders.ts) before accepting new traffic, so a
  // crash-and-restart never leaves a customer-visible order silently stuck.
  await recoverStuckOrders(store, saga);

  const sseHub = new SseHub(eventBus);

  const app = express();
  app.use(express.json());

  app.use("/api", ordersRouter(saga, store));
  app.use("/api", businessRouter(businessStore));
  app.use("/api", inventoryRouter(inventory));
  app.use("/api", metricsRouter());

  app.get("/api/events/stream", (req, res) => sseHub.addClient(res));
  app.get("/metrics", (_req, res) => res.type("text/plain").send(metricsSnapshotText()));

  // Liveness: is the process itself alive and able to handle a request?
  // Kubernetes restarts the pod if this fails — keep it dependency-free so a
  // slow/unreachable Redis doesn't cause a crash-loop instead of just
  // failing readiness (below).
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Readiness: can this pod actually serve traffic right now? Checked
  // against Redis (the one hard dependency on the request path) with a
  // short timeout — Kubernetes pulls the pod out of Service rotation on
  // failure instead of restarting it, which is the right response to
  // "Redis is temporarily unreachable" (self-healing without a crash-loop).
  app.get("/readyz", async (_req, res) => {
    try {
      await Promise.race([
        redis.get("__readyz_probe__"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
      ]);
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });

  app.use("/dashboard", express.static(path.join(__dirname, "../dashboard")));

  // Last-resort error handler. Express only forwards synchronous throws to
  // this automatically; every async route above is wrapped in asyncHandler
  // (src/api/asyncHandler.ts) specifically so a rejected promise ends up
  // here too, as a clean JSON 500, instead of an unhandled rejection that
  // would otherwise crash the whole process on a single bad request. Must
  // be registered after every other app.use()/route.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled request error:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" });
  });

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`supply-chain-saga listening on http://localhost:${port}`);
    console.log(`Dashboard: http://localhost:${port}/dashboard`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
