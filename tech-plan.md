# Tech Plan: .NET + React + PostgreSQL + AWS

Technical design for the business flow and rules defined in [business-plan.md](business-plan.md).

## Stack

| Concern | Choice |
|---|---|
| Services | ASP.NET Core Minimal APIs (.NET 8) |
| Workers | .NET `BackgroundService` (Worker Service template) |
| Frontend | React + Vite, fetch + `@tanstack/query` |
| Database | Amazon RDS for PostgreSQL |
| Cache | Amazon ElastiCache for Redis |
| Broker | Amazon SNS (fan-out) + SQS (one queue per consumer) |
| API Gateway | Amazon API Gateway (HTTP API) |
| Load balancer | Internal Application Load Balancer, behind the gateway via VPC Link |
| Compute | ECS Fargate |
| Frontend hosting | S3 + CloudFront |
| IaC | AWS CDK in C# |
| CI/CD | GitHub Actions → ECR → ECS; S3 sync + CloudFront invalidation for the SPA |

## Request path

```
Browser (React on CloudFront)
   │
   ▼
Amazon API Gateway (HTTP API, public)
   │  VPC Link
   ▼
Internal ALB  ──▶ ECS Fargate: Catalog Service (2 tasks, round-robin)
             ──▶ ECS Fargate: Order Service
             ──▶ ECS Fargate: Inventory Service
```

- API Gateway owns the public surface: routing, throttling, and an API-key usage plan on `/admin/*`.
- The ALB distributes traffic across task instances; Catalog runs 2 tasks.

## API surface

Public, through API Gateway:
- `GET /events`
- `GET /events/{id}`
- `POST /orders`
- `GET /orders/{id}`
- `POST /admin/events` (API-key usage plan)
- `PUT /admin/events/{id}` (API-key usage plan)

Purchase flow:
1. `GET /events` → API Gateway → ALB → Catalog Service → Redis (cache hit) or Postgres (miss, then cached).
2. `POST /orders` → API Gateway → ALB → Order Service.
3. Order Service calls Inventory Service synchronously to reserve stock.
4. Order Service writes the order as `pending`, publishes `OrderCreated` to SNS, returns `202`.
5. Payment worker (SQS) picks up `OrderCreated`, simulates payment, publishes `PaymentSucceeded`/`PaymentFailed`, updates order status; on failure, releases the Inventory reservation.
6. Notification worker (SQS) picks up `PaymentSucceeded`, generates the ticket record, logs the confirmation.

## Backend architecture: Vertical Slices

One project per service, one folder per use case. A feature folder holds everything that use case needs (endpoint, handler, validation) and talks directly to the database, cache, and broker. A feature's handler is called directly from its endpoint. Add an interface for a dependency only where a specific feature needs to swap or mock it.

```
Order.Api/
  Features/
    CreateOrder/          → Endpoint + Handler + Validator
    GetOrderById/         → Endpoint + Handler
    ...
  Common/                 → DbContext, shared entities, SNS/Redis clients
  Program.cs              → DI wiring, maps each endpoint to its feature handler
```

## Services

**Catalog Service** — reads events from Postgres, caches list/detail responses in ElastiCache Redis with a short TTL, invalidates on admin update.

**Inventory Service** — owns stock counts. The reserve step is a single `UPDATE ... WHERE available > 0 RETURNING`, so Postgres serializes concurrent reservations per row.

**Order Service** — validates the request, calls Inventory synchronously (HTTP, same VPC) to reserve stock, writes the order as `pending`, publishes `OrderCreated` to an SNS topic, returns `202`.

**Payment/Notification Worker** — one process, two `BackgroundService`s, each polling its own SQS queue subscribed to the SNS topic:
- Payment queue: simulate payment, publish `PaymentSucceeded`/`PaymentFailed`, update order status, release inventory on failure.
- Notification queue: consume `PaymentSucceeded`, generate the ticket record, log the confirmation.

## Resilience patterns

Ordered by priority; each one only where a real failure point exists.

| Pattern | Where | Why |
|---|---|---|
| Idempotency | `POST /orders` (`Idempotency-Key` header, unique index in Order DB). Inventory `reserve`/`release` keyed by `orderId` (unique reservation row). Payment worker: unique `orderId` in a processed table. Notification worker: unique constraint on ticket `orderId`. | SQS is at-least-once and clients retry. Makes retries safe. |
| Timeout + retry (backoff + jitter) | Order → Inventory HTTP call, via `Microsoft.Extensions.Http.Resilience` (Polly v8). AWS SDK already retries SNS/SQS calls. | Retry only once idempotency exists. Always set a timeout. |
| Circuit breaker | Same Order → Inventory handler. When open, return `503` fast. | Same package as retry, near-zero extra code. |
| Transactional outbox | Order Service writes the order and an `OrderCreated` row in one transaction; a `BackgroundService` publishes to SNS. Same for `PaymentSucceeded`/`PaymentFailed` in the worker. | Avoids the dual write (order saved, SNS publish failed, order stuck `pending`). |
| Dead-letter queue | `maxReceiveCount` + DLQ on both SQS queues. | Poison messages stop looping. |
| Saga (choreography) + expiry | `PaymentFailed` → release inventory is the compensation. A sweeper cancels `pending` orders older than N minutes and releases stock. | Covers lost messages and crashed workers. |
| Graceful degradation | Catalog falls back to Postgres if Redis is down; jitter the TTL. | The cache is an optimization, not a dependency. |
| Health checks + correlation ID | `/health` per service (ALB target health). Correlation ID in HTTP headers and message attributes. | Cheap, and needed to observe the rest. |

Not adopted: service mesh, CQRS, event sourcing, bulkheads (API Gateway throttling covers it), full tracing stack.

Demo toggles: config for payment failure rate and Inventory delay/error rate, to trigger retries, the open breaker, the DLQ and compensation on demand.

## Database

One RDS PostgreSQL instance with one database per service (Catalog, Inventory, Order).

## Local development

- `docker-compose`: Postgres, Redis, and [LocalStack](https://localstack.cloud) for SNS/SQS.
- Services reach LocalStack/local endpoints via config (`AWS_ENDPOINT_URL`); the same AWS SDK calls run against real AWS when deployed.
- API Gateway and ALB exist only when deployed; locally, each service is called directly on localhost.

## Deployment milestones

1. CDK stack: VPC, RDS (Postgres), ElastiCache (Redis), ECR repos.
2. Catalog Service → ECS Fargate, backed by Redis cache.
3. Inventory Service → ECS Fargate.
4. Order Service → ECS Fargate + SNS topic.
5. Payment/Notification Worker → ECS Fargate service (no ingress) + 2 SQS queues, each with a DLQ. Order/Payment publish through an outbox table.
6. Internal ALB in front of Catalog (2 tasks).
7. API Gateway (HTTP API) with VPC Link to the ALB.
8. React SPA → S3 + CloudFront, pointed at the API Gateway URL.
9. GitHub Actions pipeline for the .NET services and the SPA.

## Definition of done

- `GET /events` returns data through the public API.
- A customer can place an order end to end and receive a confirmation.
- Two concurrent orders for the last ticket cannot both succeed.
- `OrderCreated` triggers the async worker path (SQS → payment → notification).
- Catalog reads are served from Redis on a cache hit.
- Requests are distributed across 2 Catalog tasks behind the ALB.
- All public traffic goes through API Gateway.

## Out of scope

Everything excluded in business-plan.md, plus: multi-AZ RDS, autoscaling policies, WAF, Cognito/real auth, custom domain/ACM cert.
