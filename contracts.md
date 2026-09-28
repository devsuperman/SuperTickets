# Contracts

The shared interfaces every task builds against: repo layout, HTTP APIs, messages, database schemas, configuration and ports. They are pinned down here so the tasks in [tasks.md](tasks.md) can run in parallel. A service can be built and tested against a stub of another service using only this file.

Why these choices were made lives in [tech-plan.md](tech-plan.md); the business rules behind them live in [business-plan.md](business-plan.md). If you need to change a contract, change it here first, in the same PR as the code, and check every consumer listed next to it.

## Repo layout

```
SuperTickets.slnx
global.json                      → pins the .NET 10 SDK
Directory.Build.props            → net10.0, nullable, implicit usings, warnings as errors
docker-compose.yml
src/
  SuperTickets.Shared/           → correlation ID, health checks, message contracts, outbox, SNS/SQS helpers
  Catalog.Api/                   → Features/, Common/, Program.cs, Dockerfile
  Inventory.Api/
  Order.Api/
  Order.Data/                    → OrderDbContext, entities, EF migrations for the Order database
  Worker/                        → Payment + Notification BackgroundServices, Dockerfile
  web/                           → React + Vite SPA
infra/
  localstack/init-aws.sh         → creates topic, queues, DLQs, subscriptions
  cdk/SuperTickets.Cdk/          → CDK app (C#), one stack per file
tests/
  SuperTickets.Shared.Tests/
  Catalog.Api.Tests/
  Inventory.Api.Tests/
  Order.Api.Tests/
  Worker.Tests/
scripts/
  smoke.sh                       → end-to-end check against the local stack
.github/workflows/
```

`Order.Data` is the one shared data project: the Order Service and the Worker both work on the Order database (the worker is the async half of the Order domain), so they share one `DbContext` and one set of migrations instead of two copies that can drift. `Order.Api` applies the migrations; the worker never does.

## Public HTTP API

Served through the Vite proxy locally and through CloudFront → API Gateway on AWS. Same relative paths in both.

| Method | Path | Service | Success | Errors |
|---|---|---|---|---|
| GET | `/events?search={text}` | Catalog | 200 `EventDto[]` | — |
| GET | `/events/{id}` | Catalog | 200 `EventDto` | 404 |
| GET | `/events/{id}/availability` | Inventory | 200 `AvailabilityDto` | 404 |
| POST | `/orders` | Order | 202 `OrderDto` | 400, 404, 409, 503 |
| GET | `/orders/{id}` | Order | 200 `OrderDto` | 404 |
| POST | `/admin/events` | Catalog | 201 `EventDto` + `Location` | 400, 401, 503 |
| PUT | `/admin/events/{id}` | Catalog | 200 `EventDto` | 400, 401, 404, 409, 503 |

### Conventions

- JSON, camelCase, UTC timestamps in ISO 8601, ids are UUIDs.
- Errors are RFC 9457 Problem Details (`Results.Problem` / `Results.ValidationProblem`). Validation errors use `errors: { field: [messages] }`. Business errors set `type` to one of the codes below so the SPA can branch on it.
- Every response carries `X-Correlation-Id` (echoed from the request, or generated).
- Catalog `GET` responses carry `X-Cache: HIT` or `X-Cache: MISS`.
- `/admin/*` requires `X-Api-Key` equal to the Catalog's `Admin__ApiKey`; missing or wrong → 401.

| Error `type` | Status | When |
|---|---|---|
| `sold_out` | 409 | Not enough tickets left to reserve the requested quantity |
| `event_started` | 409 | Admin update on an event whose `startsAt` has passed |
| `capacity_below_sold` | 409 | Admin sets `totalTickets` below tickets already reserved or sold |
| `dependency_unavailable` | 503 | Inventory timed out, failed, or its circuit breaker is open |

### Payloads

```jsonc
// EventDto
{ "id": "uuid", "name": "string", "venue": "string", "startsAt": "2026-12-01T20:00:00Z", "totalTickets": 500, "price": 49.90 }

// POST /admin/events and PUT /admin/events/{id} body (PUT is a full replace)
{ "name": "string", "venue": "string", "startsAt": "...", "totalTickets": 500, "price": 49.90 }

// AvailabilityDto
{ "eventId": "uuid", "available": 42 }

// POST /orders   header: Idempotency-Key: <client-generated string, 1..100 chars, required>
{ "eventId": "uuid", "quantity": 2, "customerEmail": "a@b.com" }

// OrderDto
{
  "id": "uuid", "eventId": "uuid", "quantity": 2, "customerEmail": "a@b.com",
  "status": "pending | paid | cancelled",
  "cancelReason": "sold_out | payment_failed | expired | null",
  "createdAt": "...",
  "tickets": [ { "id": "uuid", "number": 1, "status": "valid | used | cancelled" } ]
}
```

### Validation

| Field | Rule |
|---|---|
| `name`, `venue` | required, trimmed, 1–200 chars |
| `startsAt` | in the future |
| `totalTickets` | 1–100 000 |
| `price` | 0.01–100 000, two decimals |
| `quantity` | 1–10 |
| `customerEmail` | valid email, ≤ 254 chars |
| `search` | optional, ≤ 100 chars, case-insensitive match on name or venue |

`GET /events` returns only events with `startsAt` in the future, ordered by `startsAt`, at most 100.

A repeated `POST /orders` with the same `Idempotency-Key` returns the existing order (202, same body) and does no new work, except resuming an order that stopped half way (see [Order Service flow](#order-service-flow)).

## Internal HTTP API (Inventory)

Not routed by API Gateway. Called by Catalog, Order Service and Worker over the internal ALB (AWS) or the compose network (local). All calls are idempotent, so callers may retry.

| Method | Path | Caller | Success | Errors |
|---|---|---|---|---|
| PUT | `/inventory/events/{eventId}` body `{ "totalTickets": 500 }` | Catalog (admin create/update) | 200 `{ eventId, totalTickets, available }` | 400, 409 `capacity_below_sold` |
| POST | `/inventory/reservations` body `{ "orderId", "eventId", "quantity" }` | Order Service | 201 new, 200 already exists `{ orderId, eventId, quantity }` | 404 unknown event, 409 `sold_out` |
| DELETE | `/inventory/reservations/{orderId}` | Worker (payment failed), Order Service (sweeper) | 204, also when missing or already released | — |

`PUT /inventory/events/{eventId}` creates the stock row if missing. On update, `available` moves by the same delta as `totalTickets`.

## Messages

One SNS topic, `supertickets-events`. Each message has:

- body: the JSON payload below (camelCase)
- message attributes: `eventType` (String, the record name), `correlationId` (String), `messageId` (String, UUID; the outbox row id)

Subscriptions use raw message delivery and a filter policy on `eventType`, so each SQS message body is the payload and the attributes arrive as SQS message attributes.

| Queue | Filter `eventType` | DLQ | Consumer |
|---|---|---|---|
| `payment-queue` | `OrderCreated` | `payment-dlq` | Worker: payment handler |
| `notification-queue` | `PaymentSucceeded` | `notification-dlq` | Worker: notification handler |

Both queues: visibility timeout 30 s, `maxReceiveCount` 5, long polling 20 s. `PaymentFailed` has no subscriber; it is published for observability and future consumers.

```jsonc
// OrderCreated
{ "orderId": "uuid", "eventId": "uuid", "quantity": 2, "customerEmail": "a@b.com", "createdAt": "..." }
// PaymentSucceeded
{ "orderId": "uuid", "eventId": "uuid", "quantity": 2, "customerEmail": "a@b.com", "paidAt": "..." }
// PaymentFailed
{ "orderId": "uuid", "eventId": "uuid", "quantity": 2, "reason": "simulated_decline", "failedAt": "..." }
```

The records live in `SuperTickets.Shared/Messaging/Contracts`.

## Databases

One PostgreSQL server, three databases: `catalog`, `inventory`, `orders`. Each service's EF Core migrations create its database and tables on startup (`Database.MigrateAsync()`), so there is no init script, locally or on RDS. Names are snake_case.

### `catalog` (Catalog.Api)

```
events(id uuid pk, name text, venue text, starts_at timestamptz, total_tickets int,
       price numeric(10,2), created_at timestamptz, updated_at timestamptz)
```

### `inventory` (Inventory.Api)

```
stock(event_id uuid pk, total_tickets int, available int,
      check (available >= 0 and available <= total_tickets))
reservations(order_id uuid pk, event_id uuid fk → stock, quantity int,
             status text ('active' | 'released'), created_at, released_at null)
```

Reserve, in one transaction:
1. `INSERT INTO reservations ... ON CONFLICT (order_id) DO NOTHING`. Nothing inserted → return the existing row (200).
2. `UPDATE stock SET available = available - @qty WHERE event_id = @id AND available >= @qty RETURNING available`. No row → roll back, 409 `sold_out`.

Release: `UPDATE reservations SET status = 'released' ... WHERE order_id = @id AND status = 'active' RETURNING event_id, quantity`, then add the quantity back to `stock`, same transaction.

Set capacity: `UPDATE stock SET available = available + (@new - total_tickets), total_tickets = @new WHERE event_id = @id AND @new >= total_tickets - available`. No row updated on an existing event → 409 `capacity_below_sold`.

### `orders` (Order.Data, used by Order.Api and Worker)

```
orders(id uuid pk, event_id uuid, quantity int, customer_email text,
       status text ('pending' | 'paid' | 'cancelled'), cancel_reason text null,
       idempotency_key text unique, created_at, updated_at)
payments(order_id uuid pk, succeeded bool, processed_at)          → payment worker idempotency
tickets(id uuid pk, order_id uuid fk, number int, event_id uuid, customer_email text,
        status text ('valid' | 'used' | 'cancelled'), created_at,
        unique (order_id, number))                                 → notification worker idempotency
outbox(id uuid pk, type text, payload jsonb, correlation_id text,
       created_at, published_at null)                              → index on created_at where published_at is null
```

Status changes are always conditional: `UPDATE orders SET status = ... WHERE id = @id AND status = 'pending'`. Whoever loses the race (worker vs. sweeper) sees 0 rows and does nothing.

## Flows

### Order Service flow

`POST /orders`:
1. Look up `idempotency_key`. Found and not `pending`, or `pending` with an `OrderCreated` outbox row → return it.
2. Not found → insert the order as `pending` (a unique-key race returns the winner's order).
3. Reserve in Inventory (timeout, retry, circuit breaker).
4. Reserved → insert the `OrderCreated` outbox row → 202.
5. 409 from Inventory → set `cancelled` / `sold_out` → 409.
6. Timeout, error or open breaker → leave `pending` → 503. A client retry with the same key resumes at step 3; if the client never retries, the sweeper cancels the order and releases any reservation.

Sweeper (`BackgroundService` in Order.Api, every `Orders__SweepIntervalSeconds`): for orders `pending` longer than `Orders__PendingTimeoutMinutes`, call Inventory release, then set `cancelled` / `expired`.

Outbox publisher (`BackgroundService` from Shared, hosted by Order.Api): reads unpublished rows with `FOR UPDATE SKIP LOCKED`, publishes to SNS, sets `published_at`. It publishes the worker's rows too, since they share the table.

### Worker flow

Payment handler (`OrderCreated`), one transaction:
1. `payments` row for the order exists → reuse its result. Otherwise roll against `Payment__FailureRate`, insert the row, set the order `paid` or `cancelled` / `payment_failed` (conditional on `pending`), and insert `PaymentSucceeded` or `PaymentFailed` into the outbox.
2. Commit. If the result is a failure, call Inventory release (idempotent). If release throws, the message is not deleted and the redelivery repeats only the release.
3. Delete the SQS message.

Notification handler (`PaymentSucceeded`): insert tickets `1..quantity` with `ON CONFLICT DO NOTHING`, log `Confirmation sent to {email} for order {orderId}: {n} tickets`, delete the message.

A handler that throws leaves the message on the queue; after 5 receives it moves to the DLQ.

## Caching (Catalog)

| Key | Value | TTL |
|---|---|---|
| `catalog:event:{id}` | `EventDto` JSON | `Cache__TtlSeconds` ± 10 % jitter |
| `catalog:v{version}:events:{search, lowercased, empty for none}` | `EventDto[]` JSON | same |
| `catalog:version` | integer, `INCR` on every admin write | none |

Admin create/update deletes `catalog:event:{id}` and increments `catalog:version`, which orphans every cached list at once. Any Redis error is logged and the request goes to Postgres (`X-Cache: MISS`).

## Configuration

Standard ASP.NET Core configuration: `appsettings.json` defaults, environment variables override (`Section__Key`). The same keys are set by `docker-compose.yml` locally and by the CDK task definitions on AWS.

| Key | Used by | Local value / default |
|---|---|---|
| `ConnectionStrings__Catalog` | Catalog | `Host=postgres;Database=catalog;Username=postgres;Password=postgres` |
| `ConnectionStrings__Inventory` | Inventory | `...;Database=inventory;...` |
| `ConnectionStrings__Orders` | Order, Worker | `...;Database=orders;...` |
| `ConnectionStrings__Redis` | Catalog | `redis:6379` |
| `PGPASSWORD` | all with a DB | unset locally (password is in the string); ECS secret on AWS |
| `Services__InventoryUrl` | Catalog, Order, Worker | `http://inventory-api:8080` |
| `AWS_ENDPOINT_URL` | Order, Worker | `http://localstack:4566`; unset on AWS |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Order, Worker | `us-east-1`, `test`, `test`; task role on AWS |
| `Messaging__TopicArn` | Order | `arn:aws:sns:us-east-1:000000000000:supertickets-events` |
| `Messaging__PaymentQueueUrl` | Worker | `http://localstack:4566/000000000000/payment-queue` |
| `Messaging__NotificationQueueUrl` | Worker | `http://localstack:4566/000000000000/notification-queue` |
| `Admin__ApiKey` | Catalog | `dev-admin-key` |
| `Cache__TtlSeconds` | Catalog | `60` |
| `Orders__PendingTimeoutMinutes` | Order | `5` |
| `Orders__SweepIntervalSeconds` | Order | `30` |
| `Payment__FailureRate` | Worker | `0.1` |
| `Demo__DelayMs`, `Demo__ErrorRate` | Inventory | `0`, `0` (on reserve only) |
| `Demo__NotificationErrorRate` | Worker | `0` (throws in the notification handler → DLQ) |

Npgsql reads `PGPASSWORD` when the connection string has no password, which is how the RDS secret gets in without environment-specific code.

## Ports

Every .NET container listens on `8080` and serves `GET /health` (checks its DB; Catalog also reports Redis as degraded, not unhealthy).

| Compose service | Host port |
|---|---|
| `catalog-api` | 5101 |
| `inventory-api` | 5102 |
| `order-api` | 5103 |
| `web` | 5173 |
| `postgres` | 5432 |
| `redis` | 6379 |
| `localstack` | 4566 |

## Routing

The same path rules appear three times; keep them in sync.

| Path | Target | Vite proxy (local) | ALB rule | API Gateway route |
|---|---|---|---|---|
| `/events/{id}/availability` | Inventory | yes, listed first | yes, priority 1 | yes |
| `/inventory/*` | Inventory | no | yes | **no** (internal only) |
| `/events`, `/events/*` | Catalog | yes | yes | yes |
| `/admin/*` | Catalog | yes | yes | yes |
| `/orders`, `/orders/*` | Order | yes | yes | yes |

SPA routes must not start with an API prefix, or a page reload would hit the API: use `/`, `/event/:id`, `/cart`, `/order/:id`, `/manage`, `/manage/new`, `/manage/:id`.
