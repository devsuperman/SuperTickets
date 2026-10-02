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

Stack: .NET 10 Minimal APIs (Vertical Slice Architecture), React + Vite + shadcn/ui, PostgreSQL, Redis, SNS/SQS.

## Run

- **Local:** `docker compose up --build -d --wait` (LocalStack for SNS/SQS, no AWS account); the app is at http://localhost:5173. See [tech-plan.md](tech-plan.md#local-run). Verify with `scripts/smoke.sh [BASE_URL] [--no-toggles]` (`--no-toggles` skips the failure-toggle checks; about 3 min with them).
- **Build and test:** `dotnet build` and `dotnet test` (Testcontainers needs Docker); SPA: `npm ci && npm run build` in `src/web`. More commands in [CLAUDE.md](CLAUDE.md#commands).
- **AWS:** `cdk deploy --all` (ECS Fargate, RDS, ElastiCache, SNS/SQS, API Gateway + ALB, S3 + CloudFront). See [aws-publish.md](aws-publish.md).

## Status

T01–T17 implemented; the local smoke test passes against Compose. The AWS Definition of done (T18) is pending: it needs an AWS account, the one-time OIDC setup in [aws-publish.md](aws-publish.md#deploy), and a deploy. See [tasks.md](tasks.md).
