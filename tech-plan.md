# Tech Plan: .NET + React + PostgreSQL

Technical design for the business flow and rules defined in [business-plan.md](business-plan.md): the application, its code structure, its resilience patterns, and how it runs locally. The exact routes, payloads, schemas, config keys and ports live in [contracts.md](contracts.md); the work breakdown lives in [tasks.md](tasks.md).

How the same containers are published to the cloud lives in [aws-publish.md](aws-publish.md). Nothing in this file depends on it: the application code is the same in both places, and only configuration changes.

## Application stack

| Concern | Choice |
|---|---|
| Services | ASP.NET Core Minimal APIs (.NET 10) |
| Workers | .NET `BackgroundService` (Worker Service template) |
| Data access | EF Core + Npgsql, migrations applied on startup; raw SQL where atomicity matters (reserve/release) |
| HTTP resilience | `Microsoft.Extensions.Http.Resilience` (Polly v8) |
| Frontend | React + Vite + TypeScript, `react-router`, fetch + `@tanstack/query` |
| Database | PostgreSQL |
| Cache | Redis (`StackExchange.Redis`) |
| Broker | Topic fan-out + one queue per consumer, using the SNS/SQS API through its SDK (LocalStack when running locally) |
| Tests | xUnit + Testcontainers (Postgres, Redis, LocalStack) for .NET; `scripts/smoke.sh` for the running stack |

All .NET projects target .NET 10 (`net10.0`).

## API surface

Public routes:
- `GET /events` (with optional `?search=`)
- `GET /events/{id}`
- `GET /events/{id}/availability` (served by Inventory, never cached)
- `POST /orders` (`Idempotency-Key` header required)
- `GET /orders/{id}` (status plus tickets once paid)
- `POST /admin/events` (`X-Api-Key` required)
- `PUT /admin/events/{id}` (`X-Api-Key` required)

Inventory also exposes internal routes under `/inventory/*` for capacity, reserve and release. They are reachable inside the network only.

Purchase flow:
1. `GET /events` → Catalog Service → Redis (cache hit) or Postgres (miss, then cached).
2. The SPA shows availability from `GET /events/{id}/availability` and keeps the cart in the browser.
3. `POST /orders` → Order Service writes the order as `pending`.
4. Order Service calls Inventory Service synchronously to reserve stock.
5. On success it writes an `OrderCreated` outbox row and returns `202`. The outbox publisher sends it to the topic.
6. Payment worker (payment queue) picks up `OrderCreated`, simulates payment, sets the order `paid` or `cancelled`, writes `PaymentSucceeded`/`PaymentFailed` to the outbox; on failure, releases the Inventory reservation.
7. Notification worker (notification queue) picks up `PaymentSucceeded`, generates the ticket records, logs the confirmation.
8. The SPA polls `GET /orders/{id}` until the order leaves `pending` and shows the tickets.

Locally, the Vite dev server proxies these routes straight to each service (see [Running locally](#running-locally-docker-compose)). When published, a gateway and load balancer route the same paths ([aws-publish.md](aws-publish.md)).

## Backend architecture: Vertical Slices

One project per service, one folder per use case. A feature folder holds everything that use case needs (endpoint, handler, validation) and talks directly to the database, cache, and broker. A feature's handler is called directly from its endpoint. Add an interface for a dependency only where a specific feature needs to swap or mock it.

```
Order.Api/
  Features/
    CreateOrder/          → Endpoint + Handler + Validator
    GetOrderById/         → Endpoint + Handler
    ExpirePendingOrders/  → BackgroundService (sweeper)
  Common/                 → Inventory HTTP client, options
  Program.cs              → DI wiring, maps each endpoint to its feature handler
```

Two projects are shared, and only these two:
- **SuperTickets.Shared**: cross-cutting plumbing that would otherwise be copied into every service: correlation ID, health checks, message contracts, the outbox entity and publisher, topic publish and queue poll helpers.
- **Order.Data**: the Order database's `DbContext`, entities and migrations. The Order Service and the Worker are two processes working on the same Order domain, so they share its schema instead of keeping two copies.

## Services

**Catalog Service**: owns event data. Reads from Postgres, caches list/detail responses in Redis with a short, jittered TTL, and invalidates on admin writes. Admin create/update first sets the event's capacity in Inventory (idempotent `PUT`), then saves the event, so Inventory decides whether a capacity cut goes below what is already sold. Checks the admin API key.

**Inventory Service**: owns stock counts and reservations. The reserve step is a single `UPDATE ... WHERE available >= @qty RETURNING`, so Postgres serializes concurrent reservations per row. Reserve and release are keyed by `orderId`, so both are safe to retry.

**Order Service**: validates the request, writes the order as `pending`, calls Inventory synchronously over HTTP to reserve stock, writes `OrderCreated` to the outbox, returns `202`. Hosts the outbox publisher and the sweeper that expires stale `pending` orders.

**Payment/Notification Worker**: one process, two `BackgroundService`s, each polling its own queue subscribed to the topic. Uses the Order database through `Order.Data`.
- Payment queue: simulate payment, update order status, write `PaymentSucceeded`/`PaymentFailed` to the outbox, release inventory on failure.
- Notification queue: consume `PaymentSucceeded`, generate the ticket records, log the confirmation.

## Resilience patterns

Ordered by priority; each one only where a real failure point exists.

| Pattern | Where | Why |
|---|---|---|
| Idempotency | `POST /orders` (`Idempotency-Key` header, unique index in Order DB). Inventory `reserve`/`release` keyed by `orderId` (unique reservation row). Payment worker: `payments` row per `orderId`. Notification worker: unique `(order_id, number)` on tickets. | Queues deliver at least once and clients retry. Makes retries safe. |
| Timeout + retry (backoff + jitter) | Calls to Inventory from Order, Catalog and Worker, via `Microsoft.Extensions.Http.Resilience`. The broker SDK already retries its own calls. | Retry only once idempotency exists. Always set a timeout. |
| Circuit breaker | Order → Inventory reserve. When open, return `503` fast. | Same package as retry, near-zero extra code. |
| Transactional outbox | Order Service writes `OrderCreated` in the same database as the order; the worker writes `PaymentSucceeded`/`PaymentFailed` in the same transaction as the status change. One publisher in Order.Api drains the table with `SKIP LOCKED`. | Avoids the dual write (order saved, publish failed, order stuck `pending`). |
| Dead-letter queue | `maxReceiveCount` 5 + DLQ on both queues. | Poison messages stop looping. |
| Saga (choreography) + expiry | Payment failure → release inventory is the compensation. A sweeper cancels `pending` orders older than N minutes and releases stock. Status changes are conditional on `pending`, so the sweeper and the worker cannot both win. | Covers lost messages, crashed workers and clients that give up. |
| Graceful degradation | Catalog falls back to Postgres if Redis is down; jitter the TTL. | The cache is an optimization, not a dependency. |
| Health checks + correlation ID | `/health` per service (used by Compose and the load balancer). Correlation ID in HTTP headers and message attributes, included in every log line. | Cheap, and needed to observe the rest. |

Not adopted: service mesh, CQRS, event sourcing, bulkheads (gateway throttling covers it), full tracing stack.

Demo toggles: config for payment failure rate, Inventory delay/error rate and notification error rate, to trigger retries, the open breaker, the DLQ and compensation on demand. Keys are in [contracts.md](contracts.md#configuration).

## Database

One PostgreSQL server with one database per service (`catalog`, `inventory`, `orders`). No service reads another service's database; the Worker counts as part of the Order domain. Each service's EF Core migrations create its database on startup, so there is no init script, wherever it runs.

## Testing

- Each service has an xUnit test project. Integration tests run the real endpoints (`WebApplicationFactory`) against Testcontainers Postgres/Redis/LocalStack.
- A dependency on another service is stubbed at the HTTP boundary (a fake `HttpMessageHandler`) using [contracts.md](contracts.md), so services can be built in parallel.
- Must-have tests: two concurrent reservations for the last ticket (exactly one wins), idempotent replays of every idempotent operation, and the cache fallback when Redis is down.
- `scripts/smoke.sh` checks the Definition of done against the running Compose stack.

## Running locally (Docker Compose)

`docker compose up` runs the whole app on one machine. No cloud account is needed.

| Compose service | What it runs |
|---|---|
| `postgres` | PostgreSQL; the services' migrations create their databases |
| `redis` | Redis |
| `localstack` | [LocalStack](https://localstack.cloud) with SNS and SQS; an init script creates the topic, both queues, their DLQs and the filtered subscriptions |
| `catalog-api` | Catalog Service |
| `inventory-api` | Inventory Service |
| `order-api` | Order Service |
| `worker` | Payment/Notification Worker |
| `web` | React SPA on the Vite dev server |

```
Browser
   │
   ▼
web (Vite dev server, proxies API routes)
   ├──▶ catalog-api ──▶ redis, postgres
   │         └──────▶ inventory-api ──▶ postgres
   └──▶ order-api ──▶ inventory-api
            │
            ▼
        localstack (SNS → SQS) ──▶ worker ──▶ postgres, inventory-api
```

Notes:
- No gateway or load balancer. The Vite proxy follows the [routing table](contracts.md#routing), so the SPA uses the same relative routes wherever it runs.
- One instance of each service, so there is no load balancing to observe locally.
- Services find their dependencies through environment variables: connection strings for Postgres and Redis, `Services__InventoryUrl`, and `AWS_ENDPOINT_URL` pointing at LocalStack. Unset that variable and the same SDK calls go to the real broker.
- The admin API key is a fixed dev value set in `docker-compose.yml`.

## Definition of done (application)

Checked locally by `scripts/smoke.sh`. [aws-publish.md](aws-publish.md#definition-of-done) adds the checks that only make sense once published.

- `GET /events` returns data.
- A customer can place an order end to end and receive a confirmation.
- Two concurrent orders for the last ticket cannot both succeed.
- `OrderCreated` triggers the async worker path (queue → payment → notification).
- Catalog reads are served from Redis on a cache hit.
- A forced payment failure cancels the order and releases its stock; a forced notification failure lands in the DLQ.



## Out of scope

Everything excluded in business-plan.md. Infrastructure exclusions are listed in [aws-publish.md](aws-publish.md#out-of-scope).
