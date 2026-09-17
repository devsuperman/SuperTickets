# CLAUDE.md

SuperTickets: minimal ticket-selling app built to exercise cache, message broker, load balancer, API gateway, and microservices patterns. Planning stage — no code yet.

## Docs

- Business rules and scope → [mvp-plan.md](mvp-plan.md)
- Architecture, stack, AWS design → [tech-plan.md](tech-plan.md)

Read the relevant one before proposing a change. When a decision changes, update that doc — don't restate its content here.

## Conventions to hold onto

- **Vertical slices, not Clean Architecture.** One project per service, one folder per feature under `Features/`. No Domain/Infrastructure split, no repository interfaces by default — a feature talks straight to Postgres/Redis/SNS via `Common/`. Add an abstraction only when a specific feature needs one.
- Stack is fixed: ASP.NET Core Minimal APIs, React, PostgreSQL, AWS (ECS Fargate, RDS, ElastiCache, SNS/SQS, API Gateway + ALB). Don't propose alternative stacks — see tech-plan.md for the reasoning.
- Default to the smallest thing that satisfies the business rule in mvp-plan.md. This repo exists to learn the infra patterns, not to build a full marketplace.
