# SuperTickets

A minimal ticket-selling app built to learn and exercise core distributed-systems patterns: cache, message broker, load balancer, API gateway, and microservices. Not a production ticket marketplace — business rules live in [mvp-plan.md](mvp-plan.md), architecture and stack in [tech-plan.md](tech-plan.md).

## Flow

Admin creates an event → customer browses and buys tickets → payment is simulated → order triggers async processing → ticket confirmation is generated.

## Architecture

- **API Gateway** — public entrypoint, routes to services
- **Event Catalog Service** — event data, cached in Redis
- **Inventory Service** — ticket stock, reservation/release, prevents overselling
- **Order Service** — creates orders, publishes order events
- **Payment/Notification Worker** — consumes events, simulates payment, sends confirmations

Supporting infra: ElastiCache Redis (cache), SNS+SQS (broker), API Gateway + ALB (gateway/load balancer), RDS PostgreSQL (one database per service), ECS Fargate (compute). Full stack and reasoning in [tech-plan.md](tech-plan.md).

## Status

Planning stage — no code yet. Next steps are tracked in [tech-plan.md](tech-plan.md#deployment-milestones).
