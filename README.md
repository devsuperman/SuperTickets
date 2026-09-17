# SuperTickets

A minimal ticket-selling app built to learn and exercise core distributed-systems patterns: cache, message broker, load balancer, API gateway, and microservices. Not a production ticket marketplace — see [mvp-plan.md](mvp-plan.md) for the full plan.

## Flow

Admin creates an event → customer browses and buys tickets → payment is simulated → order triggers async processing → ticket confirmation is generated.

## Architecture

- **API Gateway** — public entrypoint, routes to services
- **Event Catalog Service** — event data, cached in Redis
- **Inventory Service** — ticket stock, reservation/release, prevents overselling
- **Order Service** — creates orders, publishes order events
- **Payment/Notification Worker** — consumes events, simulates payment, sends confirmations

Supporting infra: Redis (cache), RabbitMQ/Kafka (broker), NGINX/Traefik (load balancer), PostgreSQL (one DB per service), Docker Compose (local orchestration).

## Status

Planning stage — no code yet. Next steps are tracked in [mvp-plan.md](mvp-plan.md#next-steps).
