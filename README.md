# SuperTickets

Minimal ticket-selling app for learning distributed-systems patterns: cache, message broker, load balancer, API gateway, microservices. Not a production marketplace.

## Docs

| Doc | Content |
|---|---|
| [business-plan.md](business-plan.md) | Scope and business rules |
| [tech-plan.md](tech-plan.md) | Architecture, resilience patterns, local run |
| [contracts.md](contracts.md) | Routes, payloads, messages, schemas, config, ports |
| [aws-publish.md](aws-publish.md) | AWS infrastructure and deploy |
| [tasks.md](tasks.md) | Work breakdown, parallel waves |
| [CLAUDE.md](CLAUDE.md) | Conventions for coding agents |

## AI-native

Agents do most of the design, code and docs; a human reviews. The docs are the source of truth and change in the same PR as the decision. Contracts are fixed up front so tasks run in parallel against stubs.

## Flow

Admin creates an event → guest buys tickets (email only) → payment simulated → async processing → tickets generated. Unresolved pending orders expire and release stock.

## Services

| Service | Role |
|---|---|
| React SPA | Browse, buy, admin |
| Catalog | Events, Redis cache, admin API key |
| Inventory | Stock, reserve/release, no overselling |
| Order | Orders, outbox, pending-order expiry |
| Worker | Payment simulation, ticket generation |

Stack: .NET 10 Minimal APIs, React + Vite, PostgreSQL, Redis, SNS/SQS.

## Run

- **Local:** `docker compose up` (LocalStack for SNS/SQS, no AWS account). See [tech-plan.md](tech-plan.md#local-run).
- **AWS:** `cdk deploy --all` (ECS Fargate, RDS, ElastiCache, SNS/SQS, API Gateway + ALB, S3 + CloudFront). See [aws-publish.md](aws-publish.md).

## Status

Planning done, no code yet. Start with T01 in [tasks.md](tasks.md).
