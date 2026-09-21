import type { EventBus } from "../lib/eventBus.js";
import type { SagaOrchestrator } from "./sagaOrchestrator.js";

const ORDERS_TOPIC = "orders";
const CONSUMER_GROUP = "saga-runner";

/**
 * Drives the saga asynchronously off the event bus instead of inline on the
 * request path. Call this once at startup (api/server.ts) after both the
 * event bus and the SagaOrchestrator exist; from then on, every
 * order.created event — published by SagaOrchestrator.createOrder(), which
 * POST /api/orders calls and then returns immediately — triggers a run()
 * here, off to the side.
 *
 * The `void ... .catch(...)` below is deliberate, not an oversight: the
 * handler must NOT await run() to completion. EventBus.subscribe's handler
 * type is `void | Promise<void>`, and InMemoryEventBus (src/lib/eventBus.ts)
 * awaits whatever a handler returns before moving on — if we returned run()'s
 * promise here, InMemoryEventBus's publish() would block until the entire
 * saga (inventory, payment, shipping) finished, which is exactly the
 * synchronous-on-the-request-path behavior this file exists to remove. By
 * not returning that promise, the handler resolves as soon as run() hits its
 * first await, and the saga continues on its own after that — for both
 * InMemoryEventBus (used by tests and local dev without Kafka) and
 * KafkaEventBus (genuinely async by nature), the caller of publish() never
 * waits on the saga.
 *
 * A rejection from run() is already turned into a stored CANCELLED order
 * with a history entry by the saga itself in every case it currently
 * handles; this catch is a last-resort backstop against something truly
 * unexpected (e.g. the store being unreachable) so it becomes a logged
 * error instead of an unhandled promise rejection that could crash the
 * process out from under every other in-flight order.
 */
export function wireAsyncSagaExecution(eventBus: EventBus, saga: SagaOrchestrator): void {
  eventBus.subscribe(ORDERS_TOPIC, CONSUMER_GROUP, (event) => {
    if (event.type !== "order.created") return;
    const orderId = (event.payload as { orderId: string }).orderId;
    void saga.run(orderId).catch((err) => {
      console.error(`[saga] Unhandled error running saga for order ${orderId}:`, err);
    });
  });
}
