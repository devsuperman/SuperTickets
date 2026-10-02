# Contracts

Fixed interfaces every task builds against. To change one, edit this file in the same PR as the code and list the affected tasks.

## Repo layout

```
SuperTickets.slnx, global.json, Directory.Build.props, docker-compose.yml
src/
  SuperTickets.Shared/     → correlation ID, health, message contracts, outbox, RabbitMQ helpers
  Catalog.Api/  Inventory.Api/  Order.Api/   → Features/, Common/, Program.cs, Dockerfile
  Order.Data/              → Order DbContext + migrations (Order.Api migrates; Worker never does)
  Worker/                  → payment + notification handlers, Dockerfile
  web/                     → React SPA (shadcn/ui)
infra/
  nginx/nginx.conf         → gateway: routing, rate limit, Catalog load balancing
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

Topic exchange `supertickets-events`; routing key = event type. Body: JSON payload (persistent). Properties: `CorrelationId`, `MessageId` (outbox row id), header `eventType`. Records in `SuperTickets.Shared/Messaging/Contracts`. Services declare exchange, queues and bindings idempotently on startup (`RabbitMq.EnsureTopologyAsync`).

| Queue | Routing key | DLQ | Consumer |
|---|---|---|---|
| `payment-queue` | `OrderCreated` | `payment-dlq` | Worker payment handler |
| `notification-queue` | `PaymentSucceeded` | `notification-dlq` | Worker notification handler |

Queues: durable quorum queues, manual ack, failed handler → nack + requeue, `x-delivery-limit` so a message is dead-lettered (default exchange, routing key = DLQ name) after 5 deliveries. Redelivery is immediate (consumers back off ~250 ms between polls). `PaymentFailed` has no subscriber (observability only; not routed to any queue).

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

**Outbox publisher** (Order.Api): unpublished rows `FOR UPDATE SKIP LOCKED` → exchange (routing key = event type) → set `published_at`. Covers Worker rows too.

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

`appsettings.json` defaults, overridden by env vars.

| Key | Used by | Local default |
|---|---|---|
| `ConnectionStrings__Catalog` / `__Inventory` / `__Orders` | Catalog / Inventory / Order + Worker | `Host=postgres;Database=<db>;Username=postgres;Password=postgres` |
| `ConnectionStrings__Redis` | Catalog | `redis:6379` |
| `Services__InventoryUrl` | Catalog, Order, Worker | `http://inventory-api:8080` |
| `Messaging__ConnectionString` | Order, Worker | `amqp://guest:guest@rabbitmq:5672` |
| `Messaging__Exchange`, `__PaymentQueue`, `__NotificationQueue`, `__MaxDeliveries` | Order, Worker | `supertickets-events`, `payment-queue`, `notification-queue`, `5` (DLQ = queue name with `-queue` → `-dlq`) |
| `Admin__ApiKey` | Catalog | `dev-admin-key` |
| `Cache__TtlSeconds` | Catalog | `60` |
| `Orders__PendingTimeoutMinutes` / `__SweepIntervalSeconds` | Order | `5` / `30` |
| `Payment__FailureRate` | Worker | `0.1` |
| `Demo__DelayMs`, `Demo__ErrorRate` | Inventory (reserve only) | `0`, `0` |
| `Demo__NotificationErrorRate` | Worker | `0` |

## Ports

Containers listen on `8080` and serve `GET /health` (DB check; Redis reported as degraded, not unhealthy).

| Service | `gateway` | `inventory-api` | `order-api` | `postgres` | `redis` | `rabbitmq` | `rabbitmq` UI |
|---|---|---|---|---|---|---|---|
| Host port | 8080 | 5102 | 5103 | 5432 | 6379 | 5672 | 15672 |

`catalog-api` (2 replicas) and `web` have no host port; reach them through the gateway.

## Routing

The nginx gateway (`infra/nginx/nginx.conf`) owns routing; `src/web/vite.config.ts` only forwards API paths to it for `npm run dev`. Gateway rate limit: 50 rps per client, burst 100 (429 beyond). Response header `X-Upstream` shows which backend replied.

| Path | Target | Via gateway |
|---|---|---|
| `/events/{id}/availability` | Inventory | yes (matched first) |
| `/inventory/*` | Inventory | no (404); internal network only |
| `/events`, `/events/*`, `/admin/*` | Catalog (round-robin over replicas) | yes |
| `/orders`, `/orders/*` | Order | yes |
| anything else | SPA (`web`) | yes |

SPA routes avoid API prefixes: `/`, `/event/:id`, `/cart`, `/order/:id`, `/manage`, `/manage/new`, `/manage/:id`.
