# Supply Chain Saga

A distributed inventory reservation and order-fulfillment system, built
around the two problems that make real supply-chain and e-commerce backends
hard: **never oversell stock under concurrency**, and **never leave an order
half-finished when a step downstream fails.**

Full design rationale in [`docs/architecture.md`](docs/architecture.md).
Ready-to-use resume bullets (from real measured numbers, not made up ones)
in [`docs/RESUME_BULLETS.md`](docs/RESUME_BULLETS.md).

## What it does

- **Atomic inventory reservation.** Stock reservation runs as a single Redis
  Lua script (`src/inventory/reserve.lua`), so a check-then-decrement across
  any number of concurrent callers — including multiple app instances — can
  never oversell. Verified: 500 concurrent reservation attempts against 50
  units of stock accept exactly 50, every time.
- **Saga-based order fulfillment.** `reserve inventory → charge payment →
  schedule shipping → confirm`, with an explicit, idempotent compensating
  transaction for every step, so a failure at any point cleanly unwinds
  everything that already succeeded (release stock, refund payment, cancel
  shipment) instead of leaking state.
- **Multi-warehouse eventual consistency.** Each warehouse is modeled as an
  independent node consuming a shared event log through its own
  consumer-group cursor. A node that goes offline (simulated network
  partition) replays what it missed on reconnect and converges to the same
  state as every other node.
- **Live dashboard.** `/dashboard` is a real operational view, not just a
  log: KPI cards (orders by outcome, reservation accept/reject counts,
  reservation latency percentiles), an orders table with per-order saga
  timelines, a live inventory table by warehouse/SKU, and the raw saga
  transition feed over Server-Sent Events — all in one static, zero-build
  page backed by `GET /api/orders`, `GET /api/inventory`, and
  `GET /api/metrics/summary`.

## Why it's built this way

`RedisLike` and `EventBus` are narrow interfaces with two implementations
each: a zero-dependency one (`RawRespClient` over `node:net`, and
`InMemoryEventBus`) and a production one (`ioredis`, `kafkajs`). This means
the entire correctness story — no overselling, clean rollback, multi-node
convergence — is provable with nothing but Node.js and a local
`redis-server`, no `npm install` or Docker required, while the exact same
business logic runs against real Kafka and managed Redis via
`docker-compose.yml`. See `docs/architecture.md` for the full reasoning.

## Quickstart

### Option A — full stack with Docker (Kafka + Redis + Postgres)

```bash
docker compose up
npm run seed        # populate some starting stock
# API: http://localhost:3000, Dashboard: http://localhost:3000/dashboard
```

### Option B — lightweight local dev (just Redis, no Kafka/Postgres)

```bash
redis-server &                 # or `docker run -p 6379:6379 redis:7-alpine`
npm install
npm run dev
```

### Running the test suite

```bash
npm install
npm test                       # Vitest — needs a local Redis reachable at REDIS_HOST:REDIS_PORT (default 127.0.0.1:6379)
                                # tests/pgOrderStore.test.ts, tests/pgBusinessStore.test.ts,
                                # tests/concurrency.pg.test.ts and tests/chaos.test.ts also need Postgres
                                # reachable at DATABASE_URL, with the schema applied —
                                # `docker compose up postgres` provisions both.
npm run verify                 # zero-dependency verification script (tsx + raw RESP client), no npm install required beyond tsx
```

No Redis reachable at all, and nothing available to install one with (a
locked-down sandbox, no `docker`, no root)? `TEST_REDIS_DRIVER=memory npm
test` points the suite at `InMemoryRedisClient`
(`src/inventory/inMemoryRedis.ts`) instead — an in-process stand-in good
enough to unblock most of the suite, but **not** a substitute for real Redis
for anything that's actually testing cross-connection concurrency
(`tests/concurrency.load.test.ts`'s multi-instance check opens its own raw
connections and will still correctly fail without a real server — that's
by design, not a bug). The Postgres-dependent files above have no in-memory
equivalent; they need the real thing either way. Same idea for
`npm run seed` / `npm run dev`: `REDIS_DRIVER=memory` (see
`src/inventory/connectRedis.ts`) works with zero external infra.

`npm run verify` is what produced the numbers in `docs/RESUME_BULLETS.md`
and `docs/verify-output.txt` — run it yourself and quote your own output.

## API

| Method | Path                                 | Description                          |
|--------|---------------------------------------|---------------------------------------|
| PUT    | `/api/inventory`                      | Set stock for a `{warehouseId, sku, qty}` — requires a logged-in business |
| GET    | `/api/inventory/:warehouseId/:sku`    | Get current available stock           |
| POST   | `/api/orders`                         | Create an order; returns `202` immediately (`CREATED`) — the saga runs asynchronously, see `GET /api/orders/:id` |
| GET    | `/api/orders/:id`                     | Get one order (status + full history) — scoped to the caller's business, or the anonymous pool if logged out |
| GET    | `/api/orders`                         | List the caller's own orders (or the anonymous pool if logged out) |
| GET    | `/api/events/stream`                  | Server-Sent Events feed of saga transitions |
| GET    | `/metrics`                            | Plain-text metrics snapshot           |
| POST   | `/api/auth/register`                  | Register a business account (name, type, description, accent color) and start a session |
| POST   | `/api/auth/login`                     | Log in and start a session            |
| POST   | `/api/auth/logout`                    | End the session                       |
| GET    | `/api/auth/me`                        | The logged-in business's profile, or 401 |
| PATCH  | `/api/business/profile`               | Update the logged-in business's profile |

Example:

```bash
curl -X PUT localhost:3000/api/inventory -H "content-type: application/json" \
  -d '{"warehouseId":"wh-blr-1","sku":"SKU-LAPTOP-14","qty":5}'

curl -X POST localhost:3000/api/orders -H "content-type: application/json" \
  -d '{"customerId":"cust-1","amountCents":499900,"lines":[{"sku":"SKU-LAPTOP-14","qty":1,"warehouseId":"wh-blr-1"}]}'
```

Business accounts (dashboard registration/login — see `src/business/`,
`src/auth/`, `src/api/routes/business.ts`) are separate from the above and
don't scope orders/inventory to a business; see "Known gaps" below.

```bash
curl -i -c cookies.txt -X POST localhost:3000/api/auth/register -H "content-type: application/json" \
  -d '{"email":"you@company.com","password":"at least 8 characters","businessName":"Acme Retail","businessType":"b2c"}'

curl -b cookies.txt localhost:3000/api/auth/me
```

## Kubernetes

Kustomize-based manifests (`k8s/base`, `k8s/overlays/{dev,prod}`) with a
Deployment + HPA + PodDisruptionBudget for the app, StatefulSets for Redis's
would-be HA neighbors Postgres and Kafka, NetworkPolicy micro-segmentation,
and split liveness (`/healthz`) vs. readiness (`/readyz`, which actually
checks Redis) probes. See [`k8s/README.md`](k8s/README.md) for the full
rundown and a `kind`-based quickstart.

## Project layout

```
src/
  lib/            redisClient.ts, eventBus.ts — the swappable infra interfaces
  inventory/      InventoryService + reserve.lua / release.lua
  orders/         SagaOrchestrator, OrderStore
  payments/       PaymentGateway (mock, swap for a real processor)
  shipping/       ShippingProvider (mock)
  warehouse/      WarehouseNode — multi-node convergence simulation
  metrics/        lightweight counters / histograms
  api/            Express app, routes, SSE hub
  dashboard/      static live-feed dashboard (vanilla HTML/JS, SSE)
tests/            Vitest suite
scripts/
  verify.ts       zero-dependency correctness + benchmark harness
  seed.ts         demo data seeding
docs/
  architecture.md
  RESUME_BULLETS.md
  verify-output.txt
  schema.sql      Postgres schema for the production OrderStore
k8s/
  base/           Deployment/Service/HPA/PDB, Redis, Postgres, Kafka, NetworkPolicy
  overlays/       dev (kind/minikube) and prod (HA) resource profiles
  monitoring/     optional Prometheus ServiceMonitor
  README.md
```

## Known gaps / next steps

Being upfront about what this doesn't cover yet, since an interviewer will
probe exactly these. Four items that used to live in this section —
multi-tenant scoping, the Postgres recovery sweep, a real chaos test, and
async saga execution — are done now; what's below is what closing them
actually looked like, including what's still genuinely open.

- **Multi-tenant scoping**, done for orders: every `Order` carries a
  `businessId` (`docs/schema.sql`, `src/types.ts`), stamped from the
  logged-in business's session when `POST /api/orders` creates it, and
  `GET /api/orders` / `GET /api/orders/:id` only ever return an
  authenticated caller's own orders, or the shared anonymous/demo pool
  (`businessId: null`) if logged out — never a mix (`src/api/routes/orders.ts`'s
  `scopeFor()`, `tests/multitenant.test.ts`, `tests/pgOrderStore.test.ts`).
  `PUT /api/inventory` now requires a logged-in business, closing an actual
  gap (anyone could previously overwrite any warehouse's stock
  unauthenticated). What's **not** partitioned per business: warehouse
  stock levels stay a shared resource — `GET /api/inventory` is still
  public, and Redis stock keys are still just `warehouseId:sku`, not
  `businessId:warehouseId:sku`. That's a deliberate scope decision, not an
  oversight: warehouses are modeled here as shared 3PL infrastructure a
  business plugs into, not one private warehouse network per tenant, and
  partitioning Redis itself would touch `reserve.lua`/`release.lua` and
  every concurrency test for comparatively little of what an interviewer
  actually asks about. See `docs/architecture.md`'s "Multi-tenant scoping"
  for the full writeup. An existing `docker compose` Postgres volume needs
  `docs/migrations/002_add_business_id_to_orders.sql` run once; a fresh one
  picks the column up automatically from `docs/schema.sql`.
- **Async saga execution**, done: `POST /api/orders` now returns `202
  Accepted` with the order in `CREATED` status as soon as it's persisted and
  `order.created` is published — it does not wait for payment/shipping. A
  dedicated event-bus subscriber (`src/orders/asyncSagaRunner.ts`) drives
  the rest of the saga off to the side; poll `GET /api/orders/:id`, or watch
  `GET /api/events/stream`, for the outcome. `tests/asyncSaga.test.ts`
  proves the caller isn't blocked on the full run.
- **Startup recovery sweep**, done: `src/orders/recoverStuckOrders.ts` runs
  once at boot, finds every order not yet in a terminal status
  (`OrderStore.nonTerminal()`), and rolls each one back to `CANCELLED`
  through the exact same idempotent compensating-transaction path every
  other saga failure already uses (`SagaOrchestrator.recoverStuck()`) —
  covered by `tests/recovery.test.ts` at the unit level and by
  `tests/chaos.test.ts` end-to-end (see next bullet). **Residual gap,
  stated plainly:** this sweep has no distributed lock, and
  `k8s/base/app-deployment.yaml` runs 2+ replicas by default (3+ under
  `k8s/overlays/prod`) specifically to prove the no-oversell guarantee
  holds across instances — so a real rolling restart has every replica
  racing to recover the same stuck orders at once. Idempotency makes that
  harmless rather than corrupting, but it's still duplicate refund/cancel
  calls a single elected leader (a Postgres advisory lock, or `SELECT ...
  FOR UPDATE SKIP LOCKED` on the `nonTerminal()` query) should be doing
  instead. Not done.
- **Chaos/fault-injection test**, done: `tests/chaos.test.ts` spawns
  `scripts/chaos/crash-mid-saga.ts` as a real child process, lets it reserve
  inventory and durably record `INVENTORY_RESERVED` in Postgres, then
  `SIGKILL`s it — no graceful shutdown, no cleanup — and verifies the
  recovery sweep above finds that stuck order on a fresh process and cleanly
  rolls it back, with a second recovery pass proving idempotency.
- Two coverage gaps this also closed: `tests/concurrency.pg.test.ts`
  re-runs `tests/concurrency.load.test.ts`'s scenario specifically against
  `PgOrderStore` (concurrent saga runs writing to Postgres, not just
  `InventoryService`/Redis), and `tests/pgBusinessStore.test.ts` gives
  `PgBusinessStore` the same kind of Postgres integration coverage
  `tests/pgOrderStore.test.ts` already had. Both were previously missing.
- The Kubernetes manifests (`k8s/`) were written and YAML-validated in an
  environment without `kubectl`/`kind` available to run a live deploy —
  see `k8s/README.md`'s "Honest limitations" section before treating them
  as battle-tested.
