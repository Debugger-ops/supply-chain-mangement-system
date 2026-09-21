# Resume bullets — using real, measured numbers

Every number below came from actually running `npm run verify` (or the
equivalent Vitest suite) against a real local `redis-server` — see the full
console output in `docs/verify-output.txt`. Re-run it yourself before you put
these on a resume: numbers should be close, but quote what you actually see
on your machine, not what's written here.

## Suggested resume entry

**SupplyChainSaga — Distributed Inventory & Order Fulfillment System**
*TypeScript, Node.js, Redis, Kafka, Express, Zod, Vitest, Docker*
GitHub | Live Demo

- Built a distributed inventory reservation system using atomic Redis Lua
  scripts, guaranteeing zero overselling under concurrency: 500 simultaneous
  reservation attempts against 50 units of stock accept exactly 50 and reject
  exactly 450, verified across both a single connection and 10 independent
  connections simulating separate app instances.
- Measured single-reservation latency at p50 0.11ms / p99 0.59ms against
  local Redis, and sustained ~29,000 reservation decisions/sec across 10
  simulated app instances contending for the same limited stock pool with
  zero overselling.
- Designed an orchestration-style saga (reserve inventory → charge payment →
  schedule shipping → confirm) with explicit, idempotent compensating
  transactions for every step, so a payment decline or shipping failure
  after inventory was reserved automatically releases that inventory and
  refunds any charge instead of leaving stock silently locked.
- Modeled multi-warehouse eventual consistency with per-node consumer-group
  cursors over a shared event log; a warehouse node that goes offline
  (simulated network partition) resumes and replays every missed stock event
  on reconnect, converging to the same state as unaffected nodes with zero
  lost or duplicated events.
- Made order creation asynchronous end-to-end: `POST /api/orders` returns
  as soon as the order is persisted, with a dedicated event-bus subscriber
  driving inventory/payment/shipping off the request path — instead of a
  synchronous handler blocking on all three.
- Added a crash-recovery sweep that finds any order left mid-saga after a
  process death and rolls it back through the same idempotent compensating
  transactions as a live failure, and proved it with a real chaos test that
  SIGKILLs a subprocess mid-saga (not a graceful exit) and verifies a fresh
  process recovers cleanly.
- Added multi-tenant scoping: authenticated requests only ever see their own
  business's orders (a `businessId` enforced at both the API and the
  Postgres-store layer), while writes to shared warehouse inventory now
  require a logged-in session instead of being open to anyone.
- Shipped a pluggable infrastructure layer (Redis via a zero-dependency RESP
  client or `ioredis`; events via an in-memory bus or `kafkajs`) so the full
  correctness suite runs with nothing but Node and a local Redis instance,
  while the same code path runs against real Kafka and managed Redis via
  the included Docker Compose stack.
- Wrote Kubernetes manifests (Kustomize base + dev/prod overlays) with a
  HorizontalPodAutoscaler and PodDisruptionBudget for the API tier,
  StatefulSets with persistent volume claims for Kafka and Postgres,
  NetworkPolicy micro-segmentation between components, and split
  liveness/readiness probes — readiness actually checks Redis reachability
  so an unready pod is pulled out of load-balancing instead of restarted.
- Covered the system with an N-test Vitest suite (concurrency, saga
  compensation on both payment and shipping failure, multi-node convergence)
  plus a live Server-Sent Events dashboard streaming every saga transition.

*(Fill in the exact test count from `npm test` output and your GitHub/demo
links before using this. "N-test" is a placeholder — count what's actually
in `tests/` once you've run it, including any you add.)*

## Shorter versions, if you need to trim

- "Built a distributed inventory reservation system on atomic Redis Lua
  scripts preventing overselling under concurrency (500 concurrent requests
  against 50 units → exactly 50 accepted), with an orchestration saga that
  compensates cleanly on payment or shipping failure."
- "Designed a saga-based order fulfillment pipeline with idempotent
  compensating transactions and multi-warehouse eventual consistency,
  verified with a Vitest suite covering concurrency, failure injection, and
  network-partition recovery."

## Things to actually do before an interview

1. Push this to a real GitHub repo and deploy it somewhere (Railway/Render —
   same pattern as FlowGate) so "Live Demo" is a real link, not a placeholder.
2. Run `npm install && npm test` yourself and quote your own numbers — they
   should be close to the ones above but will vary with your machine.
3. Be ready to explain *why* a Lua script is atomic and a plain
   GET-then-SET isn't — that's the question this project is built to invite.
4. Be ready to explain the difference between orchestration and choreography
   sagas, and why you picked orchestration here.
5. Be ready to explain the chaos test (`tests/chaos.test.ts`) step by step —
   why it uses `SIGKILL` and not `process.exit()`, and why recovery rolls
   everything back to `CANCELLED` instead of trying to resume forward from
   wherever the crash happened. It's a strong "tell me about a time you
   tested a failure mode" answer if you actually understand it, not just ran it.
