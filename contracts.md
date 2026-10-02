# Contracts

Fixed interfaces every task builds against. To change one, edit this file in the same PR as the code and list the affected tasks.

## Repo layout

```
SuperTickets.slnx, global.json, Directory.Build.props, docker-compose.yml
src/
  SuperTickets.Shared/     → correlation ID, health, message contracts, outbox, SNS/SQS helpers
  Catalog.Api/  Inventory.Api/  Order.Api/   → Features/, Common/, Program.cs, Dockerfile
  Order.Data/              → Order DbContext + migrations (Order.Api migrates; Worker never does)
  Worker/                  → payment + notification handlers, Dockerfile
  web/                     → React SPA (shadcn/ui)
infra/
  localstack/init-aws.sh   → topic, queues, DLQs, subscriptions
  cdk/SuperTickets.Cdk/    → one stack per file
tests/                     → one xUnit project per src project
scripts/smoke.sh           → end-to-end check
.github/workflows/
```

## Public API

| Method | Path | Service | Success | Errors |
|---|---|---|---|---|
| GET | `/events?search=` | Catalog | 200 `EventDto[]` | — |
| GET | `/events/{id}` | Catalog | 200 `EventDto` | 404 |
| GET | `/events/{id}/availability` | Inventory | 200 `AvailabilityDto` | 404 |
| POST | `/orders` | Order | 202 `OrderDto` | 400, 404, 409, 503 |
| GET | `/orders/{id}` | Order | 200 `OrderDto` | 404 |
| POST | `/admin/events` | Catalog | 201 `EventDto` + `Location` | 400, 401, 503 |
| PUT | `/admin/events/{id}` | Catalog | 200 `EventDto` | 400, 401, 404, 409, 503 |

### Conventions

- JSON camelCase, UTC ISO 8601, UUID ids.
- Errors: RFC 9457 Problem Details; validation errors in `errors: { field: [msg] }`; business errors set `type` (table below).
- All responses: `X-Correlation-Id` (echoed or generated). Catalog GETs: `X-Cache: HIT|MISS`.
- `/admin/*`: `X-Api-Key` must equal `Admin__ApiKey`, else 401.
- `GET /events`: upcoming only, ordered by `startsAt`, max 100.
- `POST /orders` with a known `Idempotency-Key` returns the existing order (202) and resumes it if unfinished.

| `type` | Status | When |
|---|---|---|
| `sold_out` | 409 | Not enough stock |
| `event_started` | 409 | Update after `startsAt` |
| `capacity_below_sold` | 409 | `totalTickets` below reserved/sold |
| `dependency_unavailable` | 503 | Inventory timeout, error or open breaker |

### Payloads

```jsonc
// EventDto
{ "id": "uuid", "name": "string", "venue": "string", "startsAt": "2026-12-01T20:00:00Z", "totalTickets": 500, "price": 49.90 }
// POST/PUT /admin/events body (PUT = full replace): EventDto without id

// AvailabilityDto
{ "eventId": "uuid", "available": 42 }

// POST /orders — header Idempotency-Key (required, 1–100 chars)
{ "eventId": "uuid", "quantity": 2, "customerEmail": "a@b.com" }

// OrderDto
{ "id": "uuid", "eventId": "uuid", "quantity": 2, "customerEmail": "a@b.com",
  "status": "pending|paid|cancelled", "cancelReason": "sold_out|payment_failed|expired|null",
  "createdAt": "...", "tickets": [ { "id": "uuid", "number": 1, "status": "valid|used|cancelled" } ] }
```

### Validation

| Field | Rule |
|---|---|
| `name`, `venue` | required, trimmed, 1–200 chars |
| `startsAt` | future |
| `totalTickets` | 1–100 000 |
| `price` | 0.01–100 000, 2 decimals |
| `quantity` | 1–10 |
| `customerEmail` | valid email, ≤ 254 chars |
| `search` | optional, ≤ 100 chars, case-insensitive on name/venue |

## Internal API (Inventory)

Internal network only. All idempotent.

| Method | Path | Caller | Success | Errors |
|---|---|---|---|---|
| PUT | `/inventory/events/{eventId}` `{ totalTickets }` | Catalog | 200 `{ eventId, totalTickets, available }` (upsert) | 400, 409 `capacity_below_sold` |
| POST | `/inventory/reservations` `{ orderId, eventId, quantity }` | Order | 201 new / 200 existing | 404, 409 `sold_out` |
| DELETE | `/inventory/reservations/{orderId}` | Order (sweeper), Worker | 204 (also if missing/released) | — |

## Messages

Topic `supertickets-events`. Body: JSON payload. Attributes: `eventType`, `correlationId`, `messageId` (outbox row id). Subscriptions: raw delivery + `eventType` filter. Records in `SuperTickets.Shared/Messaging/Contracts`.

| Queue | Filter | DLQ | Consumer |
|---|---|---|---|
| `payment-queue` | `OrderCreated` | `payment-dlq` | Worker payment handler |
| `notification-queue` | `PaymentSucceeded` | `notification-dlq` | Worker notification handler |

Queues: visibility 30 s, `maxReceiveCount` 5, long poll 20 s. `PaymentFailed` has no subscriber (observability only).

```jsonc
OrderCreated     { "orderId", "eventId", "quantity", "customerEmail", "createdAt" }
PaymentSucceeded { "orderId", "eventId", "quantity", "customerEmail", "paidAt" }
PaymentFailed    { "orderId", "eventId", "quantity", "reason": "simulated_decline", "failedAt" }
```

## Databases

Databases `catalog`, `inventory`, `orders` on one server, created by each service's migrations on startup. snake_case.

```
-- catalog
events(id uuid pk, name, venue, starts_at timestamptz, total_tickets int, price numeric(10,2), created_at, updated_at)

-- inventory
stock(event_id uuid pk, total_tickets int, available int, check (0 <= available <= total_tickets))
reservations(order_id uuid pk, event_id fk, quantity int, status 'active'|'released', created_at, released_at)

-- orders (Order.Data)
orders(id uuid pk, event_id, quantity, customer_email, status 'pending'|'paid'|'cancelled',
       cancel_reason null, idempotency_key unique, created_at, updated_at)
payments(order_id pk, succeeded bool, processed_at)
tickets(id pk, order_id fk, number int, event_id, customer_email, status, created_at, unique(order_id, number))
outbox(id pk, type, payload jsonb, correlation_id, created_at, published_at null)  -- partial index on unpublished
```

Inventory SQL (each in one transaction):
- **Reserve:** `INSERT reservations ... ON CONFLICT DO NOTHING` (conflict → 200 existing); then `UPDATE stock SET available = available - @qty WHERE event_id = @id AND available >= @qty` (0 rows → rollback, 409).
- **Release:** `UPDATE reservations SET status = 'released' WHERE order_id = @id AND status = 'active' RETURNING quantity`; add it back to `stock`.
- **Set capacity:** `UPDATE stock SET available = available + (@new - total_tickets), total_tickets = @new WHERE event_id = @id AND @new >= total_tickets - available` (0 rows on existing → 409).

Order status updates always add `AND status = 'pending'`; 0 rows → do nothing.

## Flows

**`POST /orders`**
1. Key exists and order is final, or `pending` with `OrderCreated` in outbox → return it.
2. New key → insert `pending` (unique race → return winner).
3. Reserve (timeout, retry, breaker).
4. OK → insert `OrderCreated` outbox row → 202.
5. 409 → `cancelled`/`sold_out` → 409.
6. Failure → stay `pending` → 503. Same-key retry resumes at 3; otherwise the sweeper cleans up.

**Sweeper** (Order.Api, every `Orders__SweepIntervalSeconds`): `pending` older than `Orders__PendingTimeoutMinutes` → release → `cancelled`/`expired`.

**Outbox publisher** (Order.Api): unpublished rows `FOR UPDATE SKIP LOCKED` → SNS → set `published_at`. Covers Worker rows too.

**Payment handler** (`OrderCreated`)
1. In one transaction: reuse existing `payments` row, or roll `Payment__FailureRate`, insert it, update order (`paid` or `cancelled`/`payment_failed`), insert outbox event.
2. If failed → release stock. A release error leaves the message for redelivery.
3. Delete message.

**Notification handler** (`PaymentSucceeded`): insert tickets `1..quantity` `ON CONFLICT DO NOTHING`, log confirmation, delete message.

A throwing handler leaves the message; after 5 receives it goes to the DLQ.

## Cache (Catalog)

| Key | Value | TTL |
|---|---|---|
| `catalog:event:{id}` | `EventDto` | `Cache__TtlSeconds` ± 10 % |
| `catalog:v{version}:events:{search lowercased}` | `EventDto[]` | same |
| `catalog:version` | counter | none |

Admin write: `DEL catalog:event:{id}` + `INCR catalog:version`. Redis error → log, read Postgres, `X-Cache: MISS`.

## Configuration

`appsettings.json` defaults, overridden by env vars. AWS values: [aws-publish.md](aws-publish.md#configuration).

| Key | Used by | Local default |
|---|---|---|
| `ConnectionStrings__Catalog` / `__Inventory` / `__Orders` | Catalog / Inventory / Order + Worker | `Host=postgres;Database=<db>;Username=postgres;Password=postgres` |
| `ConnectionStrings__Redis` | Catalog | `redis:6379` |
| `PGPASSWORD` | DB users | unset (Npgsql uses it when the string has no password) |
| `Services__InventoryUrl` | Catalog, Order, Worker | `http://inventory-api:8080` |
| `AWS_ENDPOINT_URL` | Order, Worker | `http://localstack:4566` |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Order, Worker | `us-east-1`, `test`, `test` |
| `Messaging__TopicArn` | Order | `arn:aws:sns:us-east-1:000000000000:supertickets-events` |
| `Messaging__PaymentQueueUrl` / `__NotificationQueueUrl` | Worker | `http://localstack:4566/000000000000/<queue>` |
| `Admin__ApiKey` | Catalog | `dev-admin-key` |
| `Cache__TtlSeconds` | Catalog | `60` |
| `Orders__PendingTimeoutMinutes` / `__SweepIntervalSeconds` | Order | `5` / `30` |
| `Payment__FailureRate` | Worker | `0.1` |
| `Demo__DelayMs`, `Demo__ErrorRate` | Inventory (reserve only) | `0`, `0` |
| `Demo__NotificationErrorRate` | Worker | `0` |

## Ports

Containers listen on `8080` and serve `GET /health` (DB check; Redis reported as degraded, not unhealthy).

| Service | `catalog-api` | `inventory-api` | `order-api` | `web` | `postgres` | `redis` | `localstack` |
|---|---|---|---|---|---|---|---|
| Host port | 5101 | 5102 | 5103 | 5173 | 5432 | 6379 | 4566 |

## Routing

Keep Vite proxy, ALB and API Gateway in sync.

| Path | Target | Vite | ALB | API Gateway |
|---|---|---|---|---|
| `/events/{id}/availability` | Inventory | yes (first) | yes (first) | yes |
| `/inventory/*` | Inventory | no | yes | no |
| `/events`, `/events/*`, `/admin/*` | Catalog | yes | yes | yes |
| `/orders`, `/orders/*` | Order | yes | yes | yes |

SPA routes avoid API prefixes: `/`, `/event/:id`, `/cart`, `/order/:id`, `/manage`, `/manage/new`, `/manage/:id`.
