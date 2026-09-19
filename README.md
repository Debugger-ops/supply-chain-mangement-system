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
                                # tests/pgOrderStore.test.ts also needs Postgres reachable at DATABASE_URL,
                                # with the schema applied — `docker compose up postgres` provisions both.
npm run verify                 # zero-dependency verification script (tsx + raw RESP client), no npm install required beyond tsx
```

`npm run verify` is what produced the numbers in `docs/RESUME_BULLETS.md`
and `docs/verify-output.txt` — run it yourself and quote your own output.

## API

| Method | Path                                 | Description                          |
|--------|---------------------------------------|---------------------------------------|
| PUT    | `/api/inventory`                      | Set stock for a `{warehouseId, sku, qty}` |
| GET    | `/api/inventory/:warehouseId/:sku`    | Get current available stock           |
| POST   | `/api/orders`                         | Create and run an order through the saga |
| GET    | `/api/orders/:id`                     | Get one order (status + full history) |
| GET    | `/api/orders`                         | List all orders                       |
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
probe exactly these:

- `PgOrderStore` (a Postgres-backed `OrderStore`, `docs/schema.sql`) is
  implemented and wired in behind `ORDER_STORE=pg` (see `.env.example`,
  `docker-compose.yml`'s `app` service, `k8s/base/app-configmap.yaml`) —
  `InMemoryOrderStore` remains the default and is what the test suite uses
  unless a test explicitly opts into Postgres (`tests/pgOrderStore.test.ts`).
  Not yet done: the recovery sweep for an order stuck mid-saga after a
  restart (see "Chaos/fault-injection" below) and re-running
  `tests/concurrency.load.test.ts` against `PgOrderStore` specifically.
- Authentication (`src/auth/`, `src/business/`) covers business accounts
  only — register/login/profile at `/api/auth/*` and `/api/business/profile`,
  sessions as HMAC-signed HttpOnly cookies (scrypt-hashed passwords, both via
  Node's built-in `node:crypto`, no new dependency). It does **not** scope
  `/api/orders` or `/api/inventory` to the logged-in business — those stay
  open, matching this demo's single-tenant data model. Multi-tenant scoping
  (a `businessId` on orders/inventory, enforced per request) is the natural
  next step, not yet done. `PgBusinessStore` exists behind the same
  `ORDER_STORE=pg` flag as `PgOrderStore` but isn't covered by
  `tests/pgOrderStore.test.ts`-style Postgres integration tests yet.
- The saga is synchronous end-to-end within one HTTP request; a production
  version would likely make `POST /api/orders` return immediately after
  `order.created` and drive the rest of the saga asynchronously off the
  event bus, with `GET /api/orders/:id` used for polling/status.
- No chaos/fault-injection test that kills the process mid-saga and verifies
  recovery on restart (the TTL-based auto-release covers the Redis side of
  this, but there's no automated test for it yet).
- The Kubernetes manifests (`k8s/`) were written and YAML-validated in an
  environment without `kubectl`/`kind` available to run a live deploy —
  see `k8s/README.md`'s "Honest limitations" section before treating them
  as battle-tested.
