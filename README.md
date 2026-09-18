# SuperTickets

A minimal ticket-selling app built to learn and exercise core distributed-systems patterns: cache, message broker, load balancer, API gateway, and microservices. Not a production ticket marketplace — business rules live in [business-plan.md](business-plan.md), architecture and stack in [tech-plan.md](tech-plan.md).

## Flow

Admin creates an event → customer browses and buys tickets → payment is simulated → order triggers async processing → ticket confirmation is generated. Pending orders that aren't resolved in time are cancelled and their stock released.

## Architecture

- **React SPA** — hosted on S3 + CloudFront
- **API Gateway** — public entrypoint, routes to services through an internal ALB
- **Catalog Service** — event data, cached in Redis
- **Inventory Service** — ticket stock, reservation/release, prevents overselling
- **Order Service** — creates orders, publishes order events
- **Payment/Notification Worker** — consumes events, simulates payment, generates tickets, logs confirmations

Supporting infra: ElastiCache Redis (cache), SNS+SQS (broker), API Gateway + ALB (gateway/load balancer), RDS PostgreSQL (one database per service), ECS Fargate (compute). Full stack in [tech-plan.md](tech-plan.md).

## Resilience patterns

Idempotency, transactional outbox, dead-letter queues, saga with expiry, and a circuit breaker on the Order → Inventory call. See [tech-plan.md](tech-plan.md#resilience-patterns).

## Local development

`docker-compose` runs Postgres, Redis, and LocalStack (SNS/SQS); services are called directly on localhost. See [tech-plan.md](tech-plan.md#local-development).

## Status

Planning stage — no code yet. Next steps are tracked in [tech-plan.md](tech-plan.md#deployment-milestones).
