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
scripts/smoke.sh [BASE_URL] [--no-toggles]     # e2e Definition of done (default http://localhost:8080; ~1-2 min with toggles)
```

## Docs

| Doc | Read before touching |
|---|---|
| [business-plan.md](docs/project/business-plan.md) | Rules, scope |
| [tech-plan.md](docs/project/tech-plan.md) | Architecture, resilience, local run |
| [contracts.md](docs/project/contracts.md) | Routes, payloads, messages, schemas, config, ports |
| [tasks.md](docs/project/tasks.md) | Task scope, ownership, dependencies |

When a decision changes, update its doc in the same PR and keep README.md's summary in sync. If the change affects a concept explained in [docs/learn](docs/learn/README.md), update that guide too. Don't restate doc content here.

## Conventions

- **Tasks:** one task per branch/PR; change only the paths it owns; stub other services from contracts.md.
- **.NET: Vertical Slice Architecture:** one project per service, one folder per feature under `Features/`. Features use Postgres/Redis directly. Events go through the outbox, never direct broker publishes. Interfaces only when a feature needs one. Shared projects: `SuperTickets.Shared` and `Order.Data` only.
- **React: shadcn/ui only** for components (Tailwind for styling); add components with the shadcn CLI. Rules in tech-plan.md.
- **Fixed stack:** .NET 10 Minimal APIs, React + Vite + shadcn/ui, PostgreSQL, Redis, RabbitMQ, nginx, Docker Compose.
- **Cloud-neutral:** the whole stack runs from `docker-compose.yml`; no cloud SDKs or cloud-specific services.
- **Resilience:** only the patterns listed in tech-plan.md.
- **Smallest thing** that satisfies business-plan.md.
- **Acceptance:** Definition of done in tech-plan.md.
