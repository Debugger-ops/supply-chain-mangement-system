// A minimal event bus interface: publish(topic, event) / subscribe(topic, groupId, handler).
//
// Same rationale as redisClient.ts: the saga orchestrator and warehouse sync
// modules are written against this interface, not against Kafka directly.
//   - InMemoryEventBus: a real, working pub/sub with per-consumer-group offset
//     tracking and replay, used by this repo's tests and the sandbox
//     verification script (no network access required).
//   - KafkaEventBus: production adapter over `kafkajs`, used when KAFKA_BROKERS
//     is set. Talks to the Kafka cluster in docker-compose.yml.
//
// This mirrors how a real event-driven service is usually structured so the
// transport can be swapped (or unit-tested) without touching business logic.

export interface DomainEvent<T = Record<string, unknown>> {
  type: string;
  payload: T;
  at: number;
  key?: string; // partitioning / ordering key, e.g. orderId
}

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

export interface EventBus {
  publish(topic: string, event: DomainEvent): Promise<void>;
  subscribe(topic: string, groupId: string, handler: EventHandler): void;
  /** Returns all events published to a topic so far, in order. Used by tests/verification. */
  history(topic: string): DomainEvent[];
  close(): Promise<void>;
}

/**
 * In-memory event bus with consumer-group semantics: each group gets its own
 * cursor into the topic's log, so multiple independent consumers (e.g. the
 * order saga vs. a warehouse sync listener) can each process every event
 * exactly once, at their own pace — the same guarantee Kafka consumer groups
 * give you, just without a broker process.
 */
export class InMemoryEventBus implements EventBus {
  private topics = new Map<string, DomainEvent[]>();
  private groupCursors = new Map<string, number>(); // key: `${topic}:${groupId}`
  private groupHandlers = new Map<string, EventHandler[]>();
  private draining = false;

  async publish(topic: string, event: DomainEvent): Promise<void> {
    const log = this.topics.get(topic) ?? [];
    log.push(event);
    this.topics.set(topic, log);
    await this.drain(topic);
  }

  subscribe(topic: string, groupId: string, handler: EventHandler): void {
    const key = `${topic}:${groupId}`;
    const handlers = this.groupHandlers.get(key) ?? [];
    handlers.push(handler);
    this.groupHandlers.set(key, handlers);
    if (!this.groupCursors.has(key)) this.groupCursors.set(key, 0);
  }

  private async drain(topic: string): Promise<void> {
    // Re-entrancy guard: handlers publishing new events (e.g. compensation
    // events) during drain() must not cause overlapping delivery passes.
    if (this.draining) return;
    this.draining = true;
    try {
      let madeProgress = true;
      while (madeProgress) {
        madeProgress = false;
        for (const [key, cursor] of this.groupCursors) {
          const [t, groupId] = splitKey(key);
          if (t !== topic) continue;
          const log = this.topics.get(t) ?? [];
          if (cursor >= log.length) continue;
          const handlers = this.groupHandlers.get(key) ?? [];
          const event = log[cursor];
          for (const h of handlers) await h(event);
          this.groupCursors.set(key, cursor + 1);
          madeProgress = true;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  history(topic: string): DomainEvent[] {
    return [...(this.topics.get(topic) ?? [])];
  }

  async close(): Promise<void> {
    this.topics.clear();
    this.groupCursors.clear();
    this.groupHandlers.clear();
  }
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * Production adapter over kafkajs. Requires KAFKA_BROKERS and `npm install`
 * to have pulled in kafkajs (not available in this repo's own sandbox run).
 */
export async function createKafkaEventBus(brokers: string[], clientId: string): Promise<EventBus> {
  const { Kafka } = await import("kafkajs");
  const kafka = new Kafka({ clientId, brokers });
  const producer = kafka.producer();
  await producer.connect();
  const consumers: Array<{ stop: () => Promise<void> }> = [];
  const localHistory = new Map<string, DomainEvent[]>();

  return {
    async publish(topic, event) {
      const list = localHistory.get(topic) ?? [];
      list.push(event);
      localHistory.set(topic, list);
      await producer.send({
        topic,
        messages: [{ key: event.key, value: JSON.stringify(event) }],
      });
    },
    subscribe(topic, groupId, handler) {
      const consumer = kafka.consumer({ groupId });
      (async () => {
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: true });
        await consumer.run({
          eachMessage: async ({ message }) => {
            if (!message.value) return;
            const event = JSON.parse(message.value.toString()) as DomainEvent;
            await handler(event);
          },
        });
      })();
      consumers.push({ stop: () => consumer.disconnect() });
    },
    history(topic) {
      return [...(localHistory.get(topic) ?? [])];
    },
    async close() {
      await producer.disconnect();
      await Promise.all(consumers.map((c) => c.stop()));
    },
  };
}
