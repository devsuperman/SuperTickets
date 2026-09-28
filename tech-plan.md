# Tech Plan: .NET + React + PostgreSQL + AWS

Technical design for the business flow and rules defined in [business-plan.md](business-plan.md). The exact routes, payloads, schemas, config keys and ports live in [contracts.md](contracts.md); the work breakdown lives in [tasks.md](tasks.md).

The plan has two parts:

- **The application**: the services, the code structure and the resilience patterns. Everything up to [Running locally](#running-locally-docker-compose) applies wherever the app runs.
- **Where it runs**: [locally on Docker Compose](#running-locally-docker-compose) for development, and [published to AWS](#publishing-to-aws) for the real deployment. The application code is the same in both. Only configuration changes.

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
| Broker | SNS (fan-out) + SQS (one queue per consumer), through the AWS SDK |
| Tests | xUnit + Testcontainers (Postgres, Redis, LocalStack) for .NET; `scripts/smoke.sh` for the running stack |

All .NET projects (services, workers, CDK) target .NET 10 (`net10.0`).

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
5. On success it writes an `OrderCreated` outbox row and returns `202`. The outbox publisher sends it to SNS.
6. Payment worker (SQS) picks up `OrderCreated`, simulates payment, sets the order `paid` or `cancelled`, writes `PaymentSucceeded`/`PaymentFailed` to the outbox; on failure, releases the Inventory reservation.
7. Notification worker (SQS) picks up `PaymentSucceeded`, generates the ticket records, logs the confirmation.
8. The SPA polls `GET /orders/{id}` until the order leaves `pending` and shows the tickets.

What sits in front of the services differs by environment. Locally, the Vite dev server proxies the routes straight to each service. On AWS, CloudFront, API Gateway and an internal ALB route them. See the two sections below.

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
- **SuperTickets.Shared**: cross-cutting plumbing that would otherwise be copied into every service: correlation ID, health checks, message contracts, the outbox entity and publisher, SNS publish and SQS poll helpers.
- **Order.Data**: the Order database's `DbContext`, entities and migrations. The Order Service and the Worker are two processes working on the same Order domain, so they share its schema instead of keeping two copies.

## Services

**Catalog Service**: owns event data. Reads from Postgres, caches list/detail responses in Redis with a short, jittered TTL, and invalidates on admin writes. Admin create/update first sets the event's capacity in Inventory (idempotent `PUT`), then saves the event, so Inventory decides whether a capacity cut goes below what is already sold. Checks the admin API key.

**Inventory Service**: owns stock counts and reservations. The reserve step is a single `UPDATE ... WHERE available >= @qty RETURNING`, so Postgres serializes concurrent reservations per row. Reserve and release are keyed by `orderId`, so both are safe to retry.

**Order Service**: validates the request, writes the order as `pending`, calls Inventory synchronously over HTTP to reserve stock, writes `OrderCreated` to the outbox, returns `202`. Hosts the outbox publisher and the sweeper that expires stale `pending` orders.

**Payment/Notification Worker**: one process, two `BackgroundService`s, each polling its own SQS queue subscribed to the SNS topic. Uses the Order database through `Order.Data`.
- Payment queue: simulate payment, update order status, write `PaymentSucceeded`/`PaymentFailed` to the outbox, release inventory on failure.
- Notification queue: consume `PaymentSucceeded`, generate the ticket records, log the confirmation.

## Resilience patterns

Ordered by priority; each one only where a real failure point exists.

| Pattern | Where | Why |
|---|---|---|
| Idempotency | `POST /orders` (`Idempotency-Key` header, unique index in Order DB). Inventory `reserve`/`release` keyed by `orderId` (unique reservation row). Payment worker: `payments` row per `orderId`. Notification worker: unique `(order_id, number)` on tickets. | SQS is at-least-once and clients retry. Makes retries safe. |
| Timeout + retry (backoff + jitter) | Calls to Inventory from Order, Catalog and Worker, via `Microsoft.Extensions.Http.Resilience`. AWS SDK already retries SNS/SQS calls. | Retry only once idempotency exists. Always set a timeout. |
| Circuit breaker | Order → Inventory reserve. When open, return `503` fast. | Same package as retry, near-zero extra code. |
| Transactional outbox | Order Service writes `OrderCreated` in the same database as the order; the worker writes `PaymentSucceeded`/`PaymentFailed` in the same transaction as the status change. One publisher in Order.Api drains the table with `SKIP LOCKED`. | Avoids the dual write (order saved, SNS publish failed, order stuck `pending`). |
| Dead-letter queue | `maxReceiveCount` 5 + DLQ on both SQS queues. | Poison messages stop looping. |
| Saga (choreography) + expiry | Payment failure → release inventory is the compensation. A sweeper cancels `pending` orders older than N minutes and releases stock. Status changes are conditional on `pending`, so the sweeper and the worker cannot both win. | Covers lost messages, crashed workers and clients that give up. |
| Graceful degradation | Catalog falls back to Postgres if Redis is down; jitter the TTL. | The cache is an optimization, not a dependency. |
| Health checks + correlation ID | `/health` per service (used by Compose and the ALB). Correlation ID in HTTP headers and message attributes, included in every log line. | Cheap, and needed to observe the rest. |

Not adopted: service mesh, CQRS, event sourcing, bulkheads (API Gateway throttling covers it), full tracing stack.

Demo toggles: config for payment failure rate, Inventory delay/error rate and notification error rate, to trigger retries, the open breaker, the DLQ and compensation on demand. Keys are in [contracts.md](contracts.md#configuration).

## Database

One PostgreSQL server with one database per service (`catalog`, `inventory`, `orders`). No service reads another service's database; the Worker counts as part of the Order domain. Each service's EF Core migrations create its database on startup, the same way locally and on RDS.

## Testing

- Each service has an xUnit test project. Integration tests run the real endpoints (`WebApplicationFactory`) against Testcontainers Postgres/Redis/LocalStack.
- A dependency on another service is stubbed at the HTTP boundary (a fake `HttpMessageHandler`) using [contracts.md](contracts.md), so services can be built in parallel.
- Must-have tests: two concurrent reservations for the last ticket (exactly one wins), idempotent replays of every idempotent operation, and the cache fallback when Redis is down.
- `scripts/smoke.sh` checks the Definition of done against the running Compose stack.

## Running locally (Docker Compose)

`docker compose up` runs the whole app on one machine. No AWS account is needed.

| Compose service | What it runs | Stands in for (on AWS) |
|---|---|---|
| `postgres` | PostgreSQL; the services' migrations create their databases | RDS |
| `redis` | Redis | ElastiCache |
| `localstack` | [LocalStack](https://localstack.cloud) with SNS and SQS; an init script creates the topic, both queues, their DLQs and the filtered subscriptions | SNS + SQS |
| `catalog-api` | Catalog Service | ECS Fargate (2 tasks) |
| `inventory-api` | Inventory Service | ECS Fargate task |
| `order-api` | Order Service | ECS Fargate task |
| `worker` | Payment/Notification Worker | ECS Fargate task |
| `web` | React SPA on the Vite dev server | S3 + CloudFront |

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

How it differs from AWS:
- No API Gateway or ALB. The Vite proxy maps the same paths the ALB does ([routing table](contracts.md#routing)), so the SPA uses the same relative routes in both environments.
- One instance of each service, so there is no load balancing to observe locally.
- Services find their dependencies through environment variables: connection strings for Postgres and Redis, `Services__InventoryUrl`, and `AWS_ENDPOINT_URL` pointing at LocalStack. The AWS SDK calls are the same ones that run against real AWS. When deployed, `AWS_ENDPOINT_URL` is not set.
- The admin API key is a fixed dev value set in `docker-compose.yml`.

## Publishing to AWS

The same containers and SPA, deployed with AWS CDK (C#). Each local piece maps to a managed AWS service.

| Concern | AWS service |
|---|---|
| Compute | ECS Fargate; images built and pushed to ECR by CDK (`ContainerImage.FromAsset`) |
| Database | Amazon RDS for PostgreSQL (single instance, credentials in Secrets Manager) |
| Cache | Amazon ElastiCache for Redis |
| Broker | Amazon SNS + SQS |
| API gateway | Amazon API Gateway (HTTP API) |
| Load balancer | Internal Application Load Balancer, behind the gateway via VPC Link |
| Frontend hosting | S3 + CloudFront (CloudFront also forwards API paths to API Gateway) |
| IaC | AWS CDK in C# |
| CI/CD | GitHub Actions: build and test on every PR; `cdk deploy --all` on `main` via OIDC |

### Request path

```
Browser
   │
   ▼
CloudFront ──(default)──▶ S3 (SPA)
   │ /events*, /orders*, /admin/*
   ▼
Amazon API Gateway (HTTP API, throttled)
   │  VPC Link
   ▼
Internal ALB  ──▶ ECS Fargate: Catalog Service (2 tasks, round-robin)
             ──▶ ECS Fargate: Order Service
             ──▶ ECS Fargate: Inventory Service ◀── Catalog, Order, Worker (/inventory/*)
```

- CloudFront serves the SPA and forwards API paths (no caching) to API Gateway, so the browser only ever talks to one origin: no CORS, no API URL baked into the build. A CloudFront Function rewrites SPA routes to `/index.html` (not an error-page rule, which would also swallow API 404s).
- API Gateway owns the public surface: explicit routes only and throttling. HTTP APIs do not support API keys, so the admin key is checked by the Catalog Service itself, the same way as locally.
- The ALB distributes traffic across task instances; Catalog runs 2 tasks. `/inventory/*` is reachable on the ALB but has no API Gateway route, so it stays internal.
- The worker runs as an ECS service with no ingress. It only polls SQS.
- One RDS instance holds the three service databases. Tasks get the password as the `PGPASSWORD` secret.
- Tasks run in private subnets with one NAT gateway. Run `cdk destroy --all` when you are done; RDS, ElastiCache and the NAT gateway cost money while idle.

CDK stacks, one file each, so they can be built in parallel:

| Stack | Contents |
|---|---|
| `DataStack` | VPC, RDS, ElastiCache, security groups |
| `MessagingStack` | SNS topic, queues, DLQs, filtered subscriptions |
| `ServicesStack` | ECS cluster, 4 Fargate services, internal ALB, listener rules, IAM |
| `ApiStack` | HTTP API, VPC Link, routes, throttling |
| `WebStack` | S3 bucket, CloudFront distribution + function, `BucketDeployment` of `src/web/dist` |

### Deployment milestones

The order things first work on AWS. [tasks.md](tasks.md) schedules the work behind them in parallel.

1. CDK stack: VPC, RDS (Postgres), ElastiCache (Redis).
2. Catalog Service → ECS Fargate, backed by Redis cache.
3. Inventory Service → ECS Fargate.
4. Order Service → ECS Fargate + SNS topic.
5. Payment/Notification Worker → ECS Fargate service (no ingress) + 2 SQS queues, each with a DLQ. Order/Payment publish through an outbox table.
6. Internal ALB in front of Catalog (2 tasks).
7. API Gateway (HTTP API) with VPC Link to the ALB.
8. React SPA → S3 + CloudFront, forwarding API paths to API Gateway.
9. GitHub Actions pipeline for the .NET services and the SPA.

### Definition of done

- `GET /events` returns data through the public API.
- A customer can place an order end to end and receive a confirmation.
- Two concurrent orders for the last ticket cannot both succeed.
- `OrderCreated` triggers the async worker path (SQS → payment → notification).
- Catalog reads are served from Redis on a cache hit.
- Requests are distributed across 2 Catalog tasks behind the ALB.
- All public traffic goes through API Gateway.

## Out of scope

Everything excluded in business-plan.md, plus: multi-AZ RDS, autoscaling policies, WAF, Cognito/real auth, custom domain/ACM cert.
