# Tech Plan: .NET + React + PostgreSQL + AWS

Technical design for the business flow and rules defined in [mvp-plan.md](mvp-plan.md) — architecture, stack, and infrastructure choices live here; mvp-plan.md stays scoped to business rules.

## Stack at a glance

| Concern | Choice | Why |
|---|---|---|
| Services | ASP.NET Core Minimal APIs (.NET 8) | one small project per service, no controller boilerplate |
| Workers | .NET `BackgroundService` (Worker Service template) | same runtime/SDK as the APIs |
| Frontend | React + Vite, plain fetch/`@tanstack/query` | no need for Next.js, there's no SSR requirement |
| Database | PostgreSQL via Amazon RDS | matches mvp-plan; managed, no patching |
| Cache | Amazon ElastiCache for Redis | direct AWS equivalent of mvp-plan's Redis |
| Broker | Amazon SNS (fan-out) + SQS (per-consumer queues) | fully managed, nothing to operate; satisfies "message broker" learning goal without running RabbitMQ/Kafka yourself |
| API Gateway | Amazon API Gateway (HTTP API) | public entrypoint, routing, throttling |
| Load balancer | Application Load Balancer, internal, behind the gateway via VPC Link | separate component from the gateway so both patterns are actually demonstrated |
| Compute | ECS Fargate | containers without managing EC2 hosts |
| Frontend hosting | S3 + CloudFront | static SPA, no server needed |
| IaC | AWS CDK in C# | one language for app and infra |
| CI/CD | GitHub Actions → ECR → ECS; S3 sync + CloudFront invalidation for the SPA | |

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

- API Gateway owns the public surface (routing, throttling, an API-key usage plan on `/admin/*` — skip real auth for MVP, per mvp-plan).
- ALB owns traffic distribution across task instances — run 2 tasks of Catalog (or Order) to actually see load balancing, same as mvp-plan's milestone.
- These are kept as two distinct hops on purpose, otherwise API Gateway alone would make the ALB pointless to add.

## API surface

Public, through API Gateway:
- `GET /events`
- `GET /events/{id}`
- `POST /orders`
- `GET /orders/{id}`
- `POST /admin/events` (API-key usage plan, no real auth for MVP)
- `PUT /admin/events/{id}` (same)

End-to-end flow for a purchase:
1. `GET /events` → API Gateway → ALB → Catalog Service → Redis (cache hit) or Postgres (miss, then cached).
2. `POST /orders` → API Gateway → ALB → Order Service.
3. Order Service calls Inventory Service synchronously to reserve stock.
4. Order Service writes the order as `pending`, publishes `OrderCreated` to SNS, returns `202`.
5. Payment worker (SQS) picks up `OrderCreated`, simulates payment, publishes `PaymentSucceeded`/`PaymentFailed`, updates order status; on failure, releases the Inventory reservation.
6. Notification worker (SQS) picks up `PaymentSucceeded`, generates the ticket record, logs the confirmation.

## Definition of done

- `GET /events` returns data through the public API.
- A customer can place an order end to end and receive a confirmation.
- Two concurrent orders for the last ticket cannot both succeed.
- `OrderCreated` visibly triggers the async worker path (SQS → payment → notification).
- Catalog reads are served from Redis, not Postgres, on a cache hit.
- Requests are distributed across 2 Catalog tasks behind the ALB.
- All public traffic goes through API Gateway — no direct access to a service's ALB/task.

## Backend architecture: Vertical Slices

Each service (Catalog, Inventory, Order) has 2-4 endpoints total, so there's no layering to protect — organize by feature instead. **One project per service**, one folder per use case; a folder holds everything that use case needs (endpoint, handler, validation), and talks directly to the database/cache/broker. No Domain/Infrastructure split, no repository interfaces, no enforced dependency direction between layers — there are no layers.

```
Order.Api/
  Features/
    CreateOrder/          → Endpoint + Handler + Validator, one folder, one use case
    GetOrderById/         → Endpoint + Handler
    ...
  Common/                 → DbContext, shared entities, SNS/Redis clients — used directly by any feature
  Program.cs              → DI wiring, maps each endpoint to its feature handler
```

Skip MediatR and a generic repository: one process per service, one handler per endpoint — call it directly, no in-process bus to route through. A feature's handler calls EF Core/Npgsql/the SNS client straight from `Common/` — add an interface only for a feature that specifically needs to swap or mock that dependency, not by default.

```
ponytail: no repository/interface indirection by default — a feature is allowed to know it's talking to Postgres. Add an abstraction only where a specific feature needs one (e.g. a unit test that can't hit a real DB).
```

## Services → AWS mapping

**Catalog Service** (ASP.NET Core) — reads events from Postgres, caches list/detail responses in ElastiCache Redis with a short TTL, invalidates on admin update.

**Inventory Service** (ASP.NET Core) — owns stock counts. Use a single `UPDATE ... WHERE available > 0 RETURNING` (optimistic row-level check) for the reserve step instead of a distributed lock — Postgres already serializes this correctly per row.

**Order Service** (ASP.NET Core) — validates request, calls Inventory synchronously (HTTP, same VPC) to reserve stock, writes the order as `pending`, publishes `OrderCreated` to an SNS topic, returns `202`.

**Payment/Notification Worker** (.NET Worker Service) — one process, two `BackgroundService`s, each polling its own SQS queue (subscribed to the SNS topic):
- Payment queue: simulate payment, publish `PaymentSucceeded`/`PaymentFailed`, update order status, release inventory on failure.
- Notification queue: consume `PaymentSucceeded`, generate the ticket record, log/print the "confirmation" (no real email provider, per mvp-plan).

Split into two SQS queues off one SNS topic rather than one queue both workers read — keeps each consumer's failure/retry independent without adding a second broker technology.

## Database

One RDS PostgreSQL instance for the MVP, one database per service (Catalog, Inventory, Order) inside it — not one instance per service. Same logical separation mvp-plan wants, without paying for three RDS instances while learning.

```
ponytail: shared RDS instance, per-service DBs — split into separate instances only if you need independent scaling/failure isolation.
```

## Local development

Run AWS-shaped locally instead of maintaining two code paths:
- `docker-compose`: Postgres, Redis, and [LocalStack](https://localstack.cloud) for SNS/SQS.
- Services point at LocalStack/local endpoints via config (`AWS_ENDPOINT_URL` env var); same AWS SDK calls run unchanged against real AWS in deployed environments.
- No API Gateway/ALB locally — call each service directly on localhost while developing; those two only matter once deployed.

## Deployment milestones

Follow mvp-plan's order, made concrete:

1. CDK stack: VPC, RDS (Postgres), ElastiCache (Redis), ECR repos.
2. Catalog Service → ECS Fargate, backed by Redis cache.
3. Inventory Service → ECS Fargate.
4. Order Service → ECS Fargate + SNS topic.
5. Payment/Notification Worker → ECS Fargate service (no ingress needed) + 2 SQS queues.
6. Internal ALB in front of Catalog (2 tasks) to prove load balancing.
7. API Gateway (HTTP API) with VPC Link to the ALB — public entry point.
8. React SPA → S3 + CloudFront, pointed at the API Gateway URL.
9. GitHub Actions pipeline for both the .NET services and the SPA.

## Explicitly skipped for MVP

Same exclusions as mvp-plan, plus AWS-specific ones: no multi-AZ RDS, no autoscaling policies, no WAF, no Cognito/real auth, no custom domain/ACM cert — add these only if the project moves past the learning phase.
