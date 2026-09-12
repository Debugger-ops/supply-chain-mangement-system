import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIoRedisClient, RawRespClient, type RedisLike } from "../lib/redisClient.js";
import { InMemoryEventBus, createKafkaEventBus, type EventBus } from "../lib/eventBus.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { PaymentGateway } from "../payments/paymentGateway.js";
import { ShippingProvider } from "../shipping/shippingProvider.js";
import { InMemoryOrderStore } from "../orders/orderStore.js";
import { SagaOrchestrator } from "../orders/sagaOrchestrator.js";
import { ordersRouter } from "./routes/orders.js";
import { inventoryRouter } from "./routes/inventory.js";
import { metricsRouter } from "./routes/metrics.js";
import { SseHub } from "./sseHub.js";
import { metricsSnapshotText } from "../metrics/metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function buildRedisClient(): Promise<RedisLike> {
  // REDIS_DRIVER=ioredis (recommended once `npm install` has run) talks to
  // REDIS_URL via the real ioredis client. Defaults to the zero-dependency
  // RawRespClient so `npm run dev` works even before dependencies are
  // installed, against a local `redis-server`.
  if (process.env.REDIS_DRIVER === "ioredis") {
    return createIoRedisClient(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  }
  return new RawRespClient(process.env.REDIS_HOST ?? "127.0.0.1", Number(process.env.REDIS_PORT ?? 6379));
}

async function buildEventBus(): Promise<EventBus> {
  const brokers = process.env.KAFKA_BROKERS;
  if (brokers) {
    return createKafkaEventBus(brokers.split(","), "supply-chain-saga");
  }
  return new InMemoryEventBus();
}

async function main() {
  const redis = await buildRedisClient();
  const eventBus = await buildEventBus();

  const inventory = new InventoryService(redis);
  const payments = new PaymentGateway();
  const shipping = new ShippingProvider();
  const store = new InMemoryOrderStore(); // swap for PgOrderStore (docs/schema.sql) in production
  const saga = new SagaOrchestrator(inventory, payments, shipping, eventBus, store);
  const sseHub = new SseHub(eventBus);

  const app = express();
  app.use(express.json());

  app.use("/api", ordersRouter(saga, store));
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
