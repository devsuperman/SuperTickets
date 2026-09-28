# SuperTickets

A minimal ticket-selling app built to learn and exercise core distributed-systems patterns: cache, message broker, load balancer, API gateway, and microservices. Not a production ticket marketplace. Business rules live in [business-plan.md](business-plan.md), architecture and stack in [tech-plan.md](tech-plan.md).

## AI-native development

This project is built with an AI-native approach. AI coding agents do most of the design, coding and documentation work, and I review and steer it:

- The docs come first. [business-plan.md](business-plan.md) and [tech-plan.md](tech-plan.md) are the source of truth that the agents read before they change anything, and they are updated when a decision changes.
- [CLAUDE.md](CLAUDE.md) holds the conventions the agents must follow in this repo.
- Changes arrive as small, reviewed commits and pull requests.

## Flow

Admin creates an event → customer browses and buys tickets → payment is simulated → order triggers async processing → ticket confirmation is generated. Pending orders that aren't resolved in time are cancelled and their stock released.

## Services

- **React SPA**: browse events, place orders, admin event management
- **Catalog Service**: event data, cached in Redis
- **Inventory Service**: ticket stock, reservation/release, prevents overselling
- **Order Service**: creates orders, publishes order events
- **Payment/Notification Worker**: consumes events, simulates payment, generates tickets, logs confirmations

Built with ASP.NET Core Minimal APIs (.NET 10), React + Vite, PostgreSQL (one database per service), Redis, and SNS+SQS.

## Running locally

`docker compose up` runs everything on one machine: Postgres, Redis, LocalStack (SNS/SQS), the three services, the worker, and the SPA on the Vite dev server. No AWS account is needed. See [tech-plan.md](tech-plan.md#running-locally-docker-compose).

## Publishing to AWS

The same containers deploy to AWS with CDK (C#): ECS Fargate for compute, RDS PostgreSQL, ElastiCache Redis, SNS+SQS, API Gateway in front of an internal ALB, and the SPA on S3 + CloudFront. See [tech-plan.md](tech-plan.md#publishing-to-aws).

## Resilience patterns

Idempotency, transactional outbox, dead-letter queues, saga with expiry, and a circuit breaker on the Order → Inventory call. See [tech-plan.md](tech-plan.md#resilience-patterns).

## Status

Planning stage, no code yet. Next steps are tracked in [tech-plan.md](tech-plan.md#deployment-milestones).
