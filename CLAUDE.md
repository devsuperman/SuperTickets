# CLAUDE.md

SuperTickets: minimal ticket-selling app built to exercise cache, message broker, load balancer, API gateway, and microservices patterns. Planning stage — no code yet.

## Docs

- Business rules and scope → [business-plan.md](business-plan.md)
- Architecture, stack, AWS design → [tech-plan.md](tech-plan.md)

Read the relevant one before proposing a change. When a decision changes, update that doc — don't restate its content here.

## Conventions to hold onto

- **Vertical slices.** One project per service, one folder per feature under `Features/`. A feature talks straight to Postgres/Redis via `Common/`; events go out through the outbox table, not direct SNS publishes. Add an interface only when a specific feature needs one.
- Stack is fixed: ASP.NET Core Minimal APIs (.NET 8), React + Vite, PostgreSQL, AWS (ECS Fargate, RDS, ElastiCache, SNS/SQS, API Gateway + ALB), CDK in C# — see tech-plan.md.
- Resilience patterns only where a real failure point exists; the list and priority are in tech-plan.md.
- Local dev runs against LocalStack via `AWS_ENDPOINT_URL`; API Gateway and ALB exist only when deployed.
- Default to the smallest thing that satisfies the business rule in business-plan.md. This repo exists to learn the infra patterns, not to build a full marketplace.
