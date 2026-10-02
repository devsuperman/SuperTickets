# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repo.

SuperTickets: minimal ticket app for learning cache, broker, load balancer, API gateway and microservices.

## Commands

```bash
dotnet build                                   # whole solution (warnings are errors)
dotnet test                                    # all tests
dotnet test tests/Catalog.Api.Tests            # one test project
dotnet test --filter "FullyQualifiedName~HealthTests"   # single test/class
dotnet run --project src/Catalog.Api           # run a service (set ASPNETCORE_URLS=http://localhost:8080)
docker build -f src/Catalog.Api/Dockerfile -t catalog-api .   # image per service, repo-root context
docker compose up --build -d --wait            # full local stack
scripts/smoke.sh [BASE_URL] [--no-toggles]     # e2e Definition of done (default http://localhost:5173; ~3 min with toggles)
```

## Docs

| Doc | Read before touching |
|---|---|
| [business-plan.md](business-plan.md) | Rules, scope |
| [tech-plan.md](tech-plan.md) | Architecture, resilience, local run |
| [contracts.md](contracts.md) | Routes, payloads, messages, schemas, config, ports |
| [aws-publish.md](aws-publish.md) | AWS infra, CDK, deploy |
| [tasks.md](tasks.md) | Task scope, ownership, dependencies |

When a decision changes, update its doc in the same PR and keep README.md's summary in sync. Don't restate doc content here.

## Conventions

- **Tasks:** one task per branch/PR; change only the paths it owns; stub other services from contracts.md.
- **.NET: Vertical Slice Architecture:** one project per service, one folder per feature under `Features/`. Features use Postgres/Redis directly. Events go through the outbox, never direct SNS publishes. Interfaces only when a feature needs one. Shared projects: `SuperTickets.Shared` and `Order.Data` only.
- **React: shadcn/ui only** for components (Tailwind for styling); add components with the shadcn CLI. Rules in tech-plan.md.
- **Fixed stack:** .NET 10 Minimal APIs, React + Vite + shadcn/ui, PostgreSQL, Redis, SNS/SQS, AWS via CDK in C#.
- **One codebase, two environments:** Compose locally, CDK on AWS; only config differs. No environment-specific code paths. AWS details stay in aws-publish.md.
- **Resilience:** only the patterns listed in tech-plan.md.
- **Smallest thing** that satisfies business-plan.md.
- **Acceptance:** Definition of done in tech-plan.md and aws-publish.md.
