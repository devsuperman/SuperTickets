# Tech Plan

Application design for [business-plan.md](business-plan.md). Exact routes, schemas and config: [contracts.md](contracts.md).

## Stack

| Concern | Choice |
|---|---|
| Services | ASP.NET Core Minimal APIs, .NET 10 (`net10.0`), Vertical Slice Architecture |
| Workers | `BackgroundService` |
| Data | EF Core + Npgsql, migrations on startup; raw SQL for reserve/release |
| HTTP resilience | `Microsoft.Extensions.Http.Resilience` (Polly v8) |
| Frontend | React + Vite + TypeScript, shadcn/ui (Tailwind CSS), `react-router`, `@tanstack/react-query` |
| Database | PostgreSQL, one database per service |
| Cache | Redis (`StackExchange.Redis`) |
| Broker | RabbitMQ (`RabbitMQ.Client`): one topic exchange, one quorum queue per consumer, DLQ per queue |
| Gateway / LB | nginx: routing, rate limit, round-robin over Catalog replicas |
| Tests | xUnit + Testcontainers (Postgres, Redis, RabbitMQ); `scripts/smoke.sh` for the running stack |

## Services

| Service | Owns | Does |
|---|---|---|
| Catalog | `catalog` DB | Event CRUD and search; Redis cache; admin key check; sets capacity in Inventory before saving |
| Inventory | `inventory` DB | Stock and reservations; atomic reserve; idempotent reserve/release by `orderId` |
| Order | `orders` DB | Creates orders; reserves stock; outbox publisher; expires stale `pending` orders |
| Worker | `orders` DB (via `Order.Data`) | Payment handler and notification handler, one queue each |

## Purchase flow

1. `GET /events` → Catalog → Redis, or Postgres on miss.
2. SPA shows availability (Inventory) and keeps the cart in the browser.
3. `POST /orders` → Order saves `pending` → reserves stock in Inventory (HTTP) → writes `OrderCreated` to outbox → `202`.
4. Outbox publisher → topic → payment queue.
5. Worker simulates payment → `paid` or `cancelled` + outbox event; on failure, releases stock.
6. `PaymentSucceeded` → notification queue → Worker creates tickets, logs confirmation.
7. SPA polls `GET /orders/{id}` until not `pending`.

Step-by-step logic per handler: [contracts.md › Flows](contracts.md#flows).

## Code structure

### .NET APIs: Vertical Slice Architecture

Organize by feature, not by layer: no Controllers/Services/Repositories folders.

- One project per service, one folder per feature under `Features/`.
- A feature folder holds its endpoint, handler, request/response types and validator.
- Endpoints call their handler directly (no mediator). Handlers use the DbContext, Redis and broker directly (no repositories).
- Features don't call each other; shared code goes in `Common/`.
- Add an interface only when a feature needs to swap the dependency.

```
Order.Api/
  Features/CreateOrder/  GetOrderById/  ExpirePendingOrders/
  Common/                → Inventory client, options
  Program.cs             → DI and endpoint mapping
```

Only two shared projects:
- `SuperTickets.Shared`: correlation ID, health checks, message contracts, outbox, RabbitMQ connection/topology helpers.
- `Order.Data`: Order DB context and migrations, used by Order.Api (runs migrations) and Worker.

### React app: shadcn/ui

- UI built only from shadcn/ui components, added with the shadcn CLI into `src/components/ui/`; no other component library.
- Styling with Tailwind CSS utility classes and the shadcn theme variables; no custom CSS files beyond the theme.
- Forms: shadcn `Form` (react-hook-form + zod). Feedback: shadcn `Sonner` toasts.

```
web/src/
  api/              → DTO types, fetch functions
  components/ui/    → shadcn components (generated, edit sparingly)
  pages/customer/   pages/admin/
  cart/             → localStorage cart
```

## Resilience patterns

In priority order, only where a real failure point exists.

| Pattern | Where | Why |
|---|---|---|
| Idempotency | `Idempotency-Key` on `POST /orders`; reserve/release by `orderId`; `payments` row per order; unique `(order_id, number)` on tickets | At-least-once delivery and client retries |
| Timeout + retry | All calls to Inventory | Transient failures; safe because of idempotency |
| Circuit breaker | Order → Inventory reserve; open → `503` | Fail fast when Inventory is down |
| Transactional outbox | Order and Worker write events in the same transaction as the state change; Order.Api publishes (`SKIP LOCKED`) | No dual write |
| Dead-letter queue | Both queues (quorum `x-delivery-limit`), 5 deliveries then DLQ | Poison messages stop looping |
| Saga + expiry | Payment failure → release stock; sweeper expires stale `pending` orders; status updates only `WHERE status = 'pending'` | Lost messages, crashed workers, abandoned clients |
| Graceful degradation | Catalog falls back to Postgres if Redis fails; jittered TTL | Cache is optional |
| Health + correlation ID | `/health` everywhere; `X-Correlation-Id` in headers, message attributes, logs | Observability |

Not adopted: service mesh, CQRS, event sourcing, bulkheads, full tracing.

Demo toggles (payment failure, Inventory delay/errors, notification errors) force retries, breaker, DLQ and compensation: [contracts.md › Configuration](contracts.md#configuration).

## Testing

- Integration tests per service: `WebApplicationFactory` + Testcontainers (Postgres, Redis, RabbitMQ).
- Other services stubbed with a fake `HttpMessageHandler` returning contract responses.
- Required: last-ticket race (one winner), replay of every idempotent operation, Redis-down fallback.

## Local run

`docker compose up`. Everything runs in containers; no cloud account needed.

| Service | Runs |
|---|---|
| `postgres` | PostgreSQL (databases created by migrations) |
| `redis` | Redis |
| `rabbitmq` | RabbitMQ + management UI; services declare exchange, queues, DLQs and bindings on startup |
| `catalog-api`, `inventory-api`, `order-api` | APIs |
| `worker` | Worker |
| `gateway` | nginx on :8080: the only entry point; routes per [routing](contracts.md#routing), rate-limits, load-balances Catalog |
| `web` | SPA on Vite dev server, reached through the gateway |

```
Browser → gateway (nginx)
            ├─▶ web (SPA)
            ├─▶ catalog-api ×2 ─▶ redis, postgres, inventory-api
            ├─▶ inventory-api   (availability route only)
            └─▶ order-api ─────▶ postgres, inventory-api, rabbitmq
rabbitmq (exchange → queues) ─▶ worker ─▶ postgres, inventory-api
```

- Catalog runs 2 replicas behind nginx; other services run one instance. `/inventory/*` is not routed by the gateway.
- Dependencies come from env vars (service names resolve on the Compose network).
- Admin key is a fixed dev value in `docker-compose.yml`.

## Definition of done

Checked by `scripts/smoke.sh` through the gateway.

- `GET /events` returns data.
- An order completes end to end with tickets.
- Two concurrent orders for the last ticket: one succeeds.
- `OrderCreated` drives payment → notification.
- Catalog serves cache hits from Redis.
- Forced payment failure cancels the order and restores stock; forced notification failure reaches the DLQ.
- `/inventory/*` is not reachable through the gateway; GETs are spread across both Catalog replicas.
