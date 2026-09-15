# Implementation Guide — Closing the Known Gaps

This is a self-implementation guide for the five gaps listed in the README/interview notes for `supply-chain-saga`. It gives you the steps, decision points, and gotchas for each — no code is written for you here; you build it. Each section assumes you've re-read the relevant existing files first (paths are given).

Grounded in the current repo as of this write-up:
- `src/orders/orderStore.ts` — `OrderStore` interface + `InMemoryOrderStore`
- `src/api/server.ts` — wiring, health/ready probes
- `src/orders/sagaOrchestrator.ts` — the saga steps
- `src/lib/eventBus.ts` — `InMemoryEventBus` / `KafkaEventBus`
- `src/inventory/inventoryService.ts` + `reserve.lua` / `release.lua` — Redis-atomic reservations with TTL auto-release
- `docs/schema.sql` — the Postgres schema, already written, unused
- `k8s/README.md` — "Honest limitations" section already flags the untested live deploy

---

## Priority table

| # | Gap | Why interviewers probe it | Depends on | Rough effort |
|---|---|---|---|---|
| 1 | `PgOrderStore` | Every "in-memory store" project gets asked "what happens on restart?" | none | 1–2 evenings |
| 2 | API auth/authz | Reflexive question on any HTTP API | none | 1 evening |
| 3 | Async saga | Shows you know sync-request-does-too-much is an anti-pattern | Easier after #1 (see note in §3) | 2–3 evenings |
| 4 | Chaos/recovery test | The single most impressive thing you can demo live | **Requires #1** | 2 evenings |
| 5 | Live k8s validation | Separates "wrote YAML" from "operated a cluster" | none (needs Docker Desktop / kind) | 1–2 evenings |

**Recommended order: 1 → 4 → 2 → 3 → 5.** Reasoning: #4 (chaos test) is the highest-signal thing you can add, and it's blocked on #1. #2 is cheap and independent — slot it in whenever you want a break from saga logic. #3 is the largest single change to existing code, so do it once auth is in place (you'll be re-testing the whole request path anyway). #5 is independent of all the TypeScript work and needs a different environment (Docker Desktop/kind), so it's natural to batch it into its own session.

Do these one at a time, on separate branches, and update `docs/RESUME_BULLETS.md` and `k8s/README.md`'s "Honest limitations" section as each one lands — that running edit *is* your interview prep.

---

## 1. `PgOrderStore` (Postgres-backed `OrderStore`)

**Current state:** `InMemoryOrderStore` (a `Map`) is used everywhere, including by `server.ts`. `docs/schema.sql` defines `orders`, `order_lines`, `order_events` but nothing reads/writes them.

**Target:** A second class implementing the same `OrderStore` interface (`create`, `get`, `updateStatus`, `all`) backed by the three tables, selected via an env var so tests can keep using the in-memory version.

### Steps

1. **Provision Postgres.** `docker-compose.yml` already has a `postgres` service that auto-runs `docs/schema.sql` on first boot (via the `docker-entrypoint-initdb.d` mount). Bring it up alone: `docker compose up postgres`. Confirm the tables exist with `psql` or any GUI client before writing a line of code.
2. **Add a pool wrapper**, mirroring the existing pattern in `src/lib/redisClient.ts` — a small module exporting a `pg.Pool` built from `DATABASE_URL` (already in `.env.example`). Keep it a thin wrapper, not a new abstraction — `PgOrderStore` can hold the `Pool` directly.
3. **Implement `PgOrderStore`** in a new file (e.g. `src/orders/pgOrderStore.ts`), implementing `OrderStore`:
   - `create(order)`: two writes in one transaction — insert into `orders`, then bulk-insert `order_lines`. Order and lines must land together or not at all.
   - `updateStatus(id, status, event)`: two writes in one transaction — `UPDATE orders SET status=…, updated_at=now()`, and `INSERT INTO order_events`.
   - `get(id)`: one query for the order row, one for its `order_lines`, one for `order_events` ordered by `at` (or `id`) ascending — then reassemble the `Order` shape (`history` = the events, `lines` = the lines).
   - `all()`: same reassembly, but batched — don't do the "get one order, then N+1 queries for its events" loop. Fetch all matching orders, all matching lines, all matching events in three queries, then group in memory by `order_id`.
4. **Use real transactions.** Check out a client from the pool (`pool.connect()`), `BEGIN`, do the statements, `COMMIT`, and `ROLLBACK` + release the client in a `catch`. This matters specifically because `create()` and `updateStatus()` each touch two tables — a crash between the two inserts would otherwise leave the DB inconsistent, which defeats the entire point of moving off in-memory storage.
5. **Wire it into `server.ts`:** branch on an `ORDER_STORE` env var (`ORDER_STORE=pg` → `PgOrderStore`, anything else → `InMemoryOrderStore`, matching the existing `REDIS_DRIVER` pattern already used for the Redis client). Add `ORDER_STORE=pg` to the `app` service's environment in `docker-compose.yml`, and document the var in `.env.example` next to `DATABASE_URL`.
6. **Test it.** Add `tests/pgOrderStore.test.ts`, structured like the existing tests (`tests/setup.ts` already gives you the pattern via `getTestRedisClient()` — add an analogous `getTestPgPool()`). At minimum: round-trip create→get, `updateStatus` appends to history correctly, `all()` returns everything, and a forced failure mid-`create` (e.g. a bad line) leaves zero rows behind (proves the transaction actually rolls back).
7. **Re-run the concurrency test against Postgres.** `tests/concurrency.load.test.ts` currently exercises `InMemoryOrderStore` (a JS `Map`, which is single-threaded-safe by default). Point a run at `PgOrderStore` and confirm you don't lose updates under concurrent order creation — this is a real test of your transaction boundaries, not just the Redis reservation logic.

### Gotchas

| Issue | Why it bites you |
|---|---|
| UUID format | `randomUUID()` produces a string; the `orders.id` column is `UUID` — Postgres will coerce it, but confirm your driver isn't quoting it in a way that breaks the `order_lines` foreign key. |
| `amount_cents > 0` CHECK constraint | Any test order with a zero amount will fail at the DB layer even though the app-level Zod schema might allow it — decide which validation is authoritative. |
| Pool exhaustion | Default `pg.Pool` size is small; the concurrency test opens many simultaneous requests — size the pool deliberately and note the number you chose in a comment. |
| `order_events.detail` is `JSONB` | You're passing a JS object where `node-postgres` expects either a JSON string or relies on you casting — verify the shape lands correctly, don't assume. |

---

## 2. API authentication / authorization

**Current state:** none. Every route in `src/api/routes/*.ts` is open.

**Decision point — pick one, don't overbuild:**

| Approach | Effort | What it demonstrates |
|---|---|---|
| Static API key header (`x-api-key`) checked against an env-configured list | Low | You know APIs need a boundary; doesn't distract from the saga/distributed-systems focus |
| JWT bearer token with a shared secret + role claim | Medium | Authn *and* authz (e.g. only certain roles can see `/api/inventory`) |
| Per-customer key mapped to `customerId`, enforced so a caller can only read their own orders | Medium-high | Real-world authz shape, ties into the existing `customerId` field |

For a project whose selling point is the saga/inventory mechanics, the **API key** approach is the right scope — enough to show you didn't forget about it, without turning this into an auth-service side quest. If you want a stronger signal, do the **per-customer key** variant instead (skip plain JWT — it doesn't add much here without a real user system behind it).

### Steps

1. Write an Express middleware (e.g. `src/api/middleware/auth.ts`) that reads a header, validates it against `process.env.API_KEYS` (comma-separated, matching the `.env.example` style already in the repo), and calls `next()` or responds `401` with the same error shape the rest of the API uses (`{ error: "UNAUTHORIZED" }`, matching `INVALID_PAYLOAD` / `NOT_FOUND` conventions in `orders.ts`).
2. Apply it to `/api/*` routes **only** — `app.use("/api", authMiddleware, ...)` before mounting the routers in `server.ts`. Do **not** put it in front of `/healthz`, `/readyz`, or `/metrics` — Kubernetes probes and Prometheus scraping must stay unauthenticated, and `k8s/README.md` explicitly calls out why `/healthz`/`/readyz` need to stay simple.
3. If you go with per-customer keys: after validating, attach the resolved `customerId` to `req` and check it against `order.customerId` in the `GET /api/orders/:id` handler, returning `404` (not `403` — don't leak existence) on mismatch.
4. Update `scripts/seed.ts` and `scripts/verify.ts` to send the header — they currently hit the API directly and will start failing once auth is on.
5. Update the dashboard (`src/dashboard/`) fetch calls, or decide the dashboard is for local/demo use only and document that it bypasses auth (be explicit about this trade-off rather than silent).
6. Add `tests/auth.test.ts`: no header → `401`; wrong key → `401`; valid key → normal response; confirm `/healthz` and `/metrics` remain reachable without a key.
7. Store the keys the same way `k8s/base/app-secret.yaml` already stores other secrets, and reference them via env in `app-deployment.yaml` — this keeps the k8s manifests honest about the new dependency.

---

## 3. Async saga (decouple the HTTP request from full saga completion)

**Current state:** `POST /api/orders` calls `saga.createOrder()` then `saga.run()` **synchronously in the same request**, and only responds once the order reaches a terminal state (`orders.ts`, lines ~28–33).

**Target (from your own README notes):** `POST /api/orders` returns immediately after `order.created`; the rest of the saga (reserve → charge → ship → confirm) runs off the event bus; `GET /api/orders/:id` is the polling/status endpoint.

### Steps

1. **Don't rewrite `SagaOrchestrator.run()`.** Its step sequence is correct and well-structured — the problem is *who calls it and when*, not the logic inside it. Keep `run()` as-is.
2. **Add a subscriber.** In `server.ts` (or a new `src/orders/sagaWorker.ts`), call `eventBus.subscribe("orders", "saga-worker", handler)` where `handler` checks `event.type === "order.created"` and, on match, calls `saga.run(event.payload.orderId)`. This is the same consumer-group mechanism `warehouseSync.ts` presumably already uses to listen to the same topic independently — read that file to confirm the pattern before adding a second listener.
3. **Change the route.** `POST /api/orders` in `orders.ts` now calls only `saga.createOrder(...)`, responds `202 Accepted` with `{ orderId, status: "CREATED" }`, and sets a `Location: /api/orders/:id` header. It no longer awaits `saga.run()`.
4. **`GET /api/orders/:id` becomes the real polling endpoint** — it already exists and already returns the live order; verify it correctly reflects every intermediate status (`INVENTORY_RESERVED`, `PAYMENT_CHARGED`, etc.) while the async worker is mid-flight.
5. **Update `scripts/seed.ts` / `scripts/verify.ts`.** These almost certainly assume the old synchronous `201` response. They now need to `POST`, then poll `GET /api/orders/:id` (with a short interval + timeout) until `status` is one of the terminal values (`CONFIRMED`, `CANCELLED`, `FAILED`). Write this polling helper once and reuse it in both scripts.
6. **Update `tests/saga.test.ts`.** It currently calls `saga.createOrder()` then `saga.run()` directly — that's fine and should keep working unchanged, since you're not touching `SagaOrchestrator` itself. What *does* need new coverage is the route-level behavior: add an API-level test (or extend an existing one) asserting `POST /api/orders` returns `202` immediately and the order only reaches its terminal state some time after, observable via polling `GET`.
7. **Use the existing SSE hub for a live demo.** `src/api/sseHub.ts` + `/api/events/stream` already exists — point the dashboard at it so a demo visibly shows an order moving through states in real time instead of just flipping straight to CONFIRMED. This is a good "show, don't tell" moment in an interview.
8. **Document the eventual-consistency window explicitly.** Right after `POST` returns, an immediate `GET` may still show `CREATED` — this is expected, not a bug. Say so in the README so nobody (including you, six months from now) mistakes it for a race condition.

**Note on sequencing with #1 (`PgOrderStore`):** this works with `InMemoryOrderStore` too, but it's more convincing once orders survive a restart — otherwise "async" just means "the in-memory saga runs a moment later in the same process," which is a smaller claim. Not a hard blocker, just weaker without it.

---

## 4. Chaos / fault-injection test (process kill mid-saga, verify recovery on restart)

**Hard prerequisite: do §1 first.** `InMemoryOrderStore` cannot survive a process restart by definition — its state is a `Map` in RAM. There is nothing to recover if that's still your store. This gap only becomes buildable once orders live in Postgres.

**What currently exists:** the Redis reservation TTL (`DEFAULT_RESERVATION_TTL_SECONDS` in `inventoryService.ts`, backed by `release.lua`) auto-expires an abandoned reservation after 15 minutes. That covers *inventory* leaking forever. It does **not** cover an order getting stuck in `INVENTORY_RESERVED`/`PAYMENT_CHARGED`/`SHIPPING_SCHEDULED` forever in Postgres with nothing ever resuming or failing it.

### What you're building

A **recovery sweep**: on process startup, query `PgOrderStore` for every order in a non-terminal state (`INVENTORY_RESERVED`, `PAYMENT_CHARGED`, `SHIPPING_SCHEDULED`, `COMPENSATING`) and re-drive each one — either resume it from its last completed step, or compensate/fail it if its reservation has already expired.

### Steps

1. **Decide resume semantics per state**, and write this down before coding — it's the actual design work here:

   | Order found in state | Recovery action |
   |---|---|
   | `INVENTORY_RESERVED` | Check reservation is still valid (not TTL-expired) → resume at payment step. If expired → compensate what little there is, mark `FAILED`. |
   | `PAYMENT_CHARGED` | Reservation may have expired by now even though payment succeeded — if so, you have a paid order with lost inventory hold: refund and mark `FAILED` (don't silently re-reserve, stock may be gone). If still valid, resume at shipping. |
   | `SHIPPING_SCHEDULED` | Resume at the commit step (commit reservations, mark `CONFIRMED`). |
   | `COMPENSATING` | Compensation itself was interrupted — re-run compensation; every compensating action must be idempotent for this to be safe (this is already noted as true in `sagaOrchestrator.ts`'s comments — verify it, don't just trust the comment). |

2. **Add a way to check reservation validity without consuming it.** Right now `InventoryService` has `reserve`/`release`/`commit`/`getAvailable` — you likely need a way to check "does `resv:<id>` still exist" (a Redis `EXISTS`/`GET` on the reservation key) before deciding whether to resume or fail. Check `reserve.lua`/`release.lua` for how the reservation key is structured.
3. **Wire the sweep into `server.ts`'s `main()`**, gated behind `ORDER_STORE === "pg"` (an in-memory store restart has no history to sweep). Run it once at startup, before the server starts accepting traffic — or after, with `/readyz` reflecting "still recovering" — your call, but document which you chose and why.
4. **Emit metrics for it**, following the existing `prom-client` pattern in `metrics.ts` (e.g. `recovery.orders_resumed`, `recovery.orders_failed` counters) — an unobservable recovery mechanism is much less convincing in an interview than one you can point at a `/metrics` line for.
5. **Write the test — realistically, not literally.** You cannot `SIGKILL` your own Vitest process mid-test. Two options:

   | Approach | How | Use for |
   |---|---|---|
   | **Simulated restart** (do this one) | Seed an order directly into `PgOrderStore` in an in-flight state (bypassing the saga entirely — just `INSERT`), instantiate a *fresh* set of services pointed at the same Postgres/Redis (simulating "a new process just started"), run the recovery sweep function directly, assert the correct terminal state and correct side effects using the existing `FailureInjection` knobs from `types.ts`. | `tests/chaos.test.ts`, part of `npm test`. |
   | **Real chaos script** | A standalone script (`scripts/chaos.ts`) that spawns the server as a real child process, fires a request, `SIGKILL`s it at a timed point, restarts it, and polls the order to confirm recovery. | A manual, demo-able artifact — impressive to run live in an interview, but too non-deterministic for CI. Keep it out of `npm test`. |

   Build the simulated-restart test for real coverage; build the chaos script afterward as a demo piece if you have time — it's the more memorable thing to show someone, but the deterministic test is what actually proves the mechanism works.
6. **Test all four states from the table above**, not just one — the whole value of this gap is showing you reasoned about *every* point the process could die, not just the easy one.

---

## 5. Live Kubernetes validation

**Current state:** manifests are YAML-syntax-validated only (`k8s/README.md` says this outright). Nothing has been `kubectl apply -k`'d against a real cluster.

### Steps

1. **Get a local cluster running.** Options for a MacBook Air:

   | Option | Notes |
   |---|---|
   | `kind` (recommended — the README's own instructions target it) | Lightweight, multi-node support (needed to properly test the PDB/drain scenario below), no GUI overhead |
   | Docker Desktop's built-in Kubernetes | Simplest to enable, but single-node only — can't test `PodDisruptionBudget` drain behavior properly |
   | `minikube` | Fine, slightly heavier than `kind` |

   Install `kubectl` + `kind` (`brew install kubectl kind`), then follow `k8s/README.md`'s existing "Try it locally (kind)" section verbatim — it's already written correctly, just never run.

2. **Go claim-by-claim through `k8s/README.md`'s "What's actually demonstrated here" section and verify each one against the real cluster:**

   | Claim | How to verify it live |
   |---|---|
   | Liveness never touches Redis; readiness does | Scale the `redis` deployment to 0 (`kubectl scale`) or block it via NetworkPolicy. Confirm the app pod is **not** restarted (`kubectl get pods` restart count stays 0) but **is** pulled from Service rotation (`kubectl get endpoints app` shows it missing). |
   | HPA + PDB together | Generate load (`k6` or `autocannon` against the port-forwarded service) and watch `kubectl get hpa -w` scale replicas up. Separately, run `kubectl drain <node>` on a multi-node `kind` cluster and confirm the PDB blocks eviction below `minAvailable`. |
   | StatefulSet + PVC for Postgres/Kafka, plain Deployment for the app | Delete the Postgres pod (`kubectl delete pod`), wait for it to be recreated, and confirm previously-written data is still there (StatefulSet + PVC survived). Delete an app pod and confirm nothing analogous is expected — it's stateless by design. |
   | NetworkPolicy micro-segmentation | Start a throwaway `busybox` pod in the same namespace and confirm it **cannot** reach Redis/Postgres/Kafka ports, while the app pod **can**. |
   | 2 replicas by default because the no-oversell guarantee must hold across pods | Send concurrent order requests (like `tests/concurrency.load.test.ts`, but against the real cluster's `Service`, so requests land on different pods) and confirm no overselling — this is the single most important live test since it's the actual thesis of the project. |

3. **Fix whatever actually breaks.** Expect at least one or two real surprises — YAML-valid isn't semantically-correct. Common culprits to check specifically: image pull (did you `kind load docker-image` after every rebuild?), whether the single-broker Kafka KRaft config actually forms a quorum on first boot, whether the PVC `storageClass` matches what `kind` provisions by default (`standard`), and whether resource `requests`/`limits` in the `prod` overlay are sane for a laptop-sized `kind` cluster if you test that overlay too.
4. **Update `k8s/README.md`'s "Honest limitations" section** once you've actually run this — replace "validate the full deploy on your own cluster before relying on it" with what you found and fixed. That delta (claimed vs. actually observed) is a genuinely strong thing to walk an interviewer through.

---

## Tracking your progress

Keep a running note (in `docs/RESUME_BULLETS.md` or a new `docs/GAPS_STATUS.md`) of, per gap: date closed, what broke that you didn't expect, and the one-line resume/interview framing. That artifact — "here's what I found once I actually tried it" — is worth more in an interview than the finished feature alone.
