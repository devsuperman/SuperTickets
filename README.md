# SuperTickets

A minimal ticket-selling app built to learn and exercise core distributed-systems patterns: cache, message broker, load balancer, API gateway, and microservices. Not a production ticket marketplace. Business rules live in [business-plan.md](business-plan.md), architecture and local run in [tech-plan.md](tech-plan.md), the AWS publish setup in [aws-publish.md](aws-publish.md), the exact APIs, messages and schemas in [contracts.md](contracts.md), and the work breakdown in [tasks.md](tasks.md).

## AI-native development

This project is built with an AI-native approach. AI coding agents do most of the design, coding and documentation work, and I review and steer it:

- The docs come first. [business-plan.md](business-plan.md), [tech-plan.md](tech-plan.md), [aws-publish.md](aws-publish.md) and [contracts.md](contracts.md) are the source of truth that the agents read before they change anything, and they are updated when a decision changes.
- The work is split into tasks that run in parallel ([tasks.md](tasks.md)). The shared contracts are fixed up front, so each agent builds its service against stubs of the others.
- [CLAUDE.md](CLAUDE.md) holds the conventions the agents must follow in this repo.
- Changes arrive as small, reviewed commits and pull requests.

## Flow

Admin creates an event → customer browses and buys tickets as a guest (email only) → payment is simulated → order triggers async processing → ticket confirmation is generated. Pending orders that aren't resolved in time are cancelled and their stock released.

## Services

- **React SPA**: browse events, place orders, admin event management
- **Catalog Service**: event data, cached in Redis; checks the admin API key
- **Inventory Service**: ticket stock, reservation/release, prevents overselling
- **Order Service**: creates orders, publishes order events through an outbox, expires stale pending orders
- **Payment/Notification Worker**: consumes events, simulates payment, generates tickets, logs confirmations (shares the Order database)

Built with ASP.NET Core Minimal APIs (.NET 10), React + Vite, PostgreSQL (one database per service), Redis, and SNS+SQS.

## Running locally

`docker compose up` runs everything on one machine: Postgres, Redis, LocalStack (SNS/SQS), the three services, the worker, and the SPA on the Vite dev server. No AWS account is needed. See [tech-plan.md](tech-plan.md#running-locally-docker-compose).

## Publishing to AWS

The same containers deploy to AWS with CDK (C#): ECS Fargate for compute, RDS PostgreSQL, ElastiCache Redis, SNS+SQS, API Gateway in front of an internal ALB, and the SPA on S3 + CloudFront, which also forwards API paths to API Gateway. See [aws-publish.md](aws-publish.md).

## Resilience patterns

Idempotency, transactional outbox, dead-letter queues, saga with expiry, and a circuit breaker on the Order → Inventory call. See [tech-plan.md](tech-plan.md#resilience-patterns).

## Status

Planning done, no code yet. The work is broken into parallel tasks in [tasks.md](tasks.md); T01 (solution skeleton) comes first.
