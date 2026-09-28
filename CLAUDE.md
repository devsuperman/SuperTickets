# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SuperTickets: minimal ticket-selling app built to exercise cache, message broker, load balancer, API gateway, and microservices patterns. Planning stage — no code yet, so there are no build/test commands. When the first project lands, add its build, test, single-test, and `docker-compose` commands here.

## Docs

- Business rules and scope → [business-plan.md](business-plan.md)
- Architecture, local Docker Compose stack, AWS publish stack → [tech-plan.md](tech-plan.md)
- [README.md](README.md) summarizes both (AI-native approach, flow, services, local run, AWS publish, resilience patterns)

Read the relevant one before proposing a change. When a decision changes, update that doc and check README.md's summary still matches — don't restate its content here.

## Conventions to hold onto

- **Vertical slices.** One project per service, one folder per feature under `Features/`. A feature talks straight to Postgres/Redis via `Common/`; events go out through the outbox table, not direct SNS publishes. Add an interface only when a specific feature needs one.
- Stack is fixed: ASP.NET Core Minimal APIs (.NET 10), React + Vite, PostgreSQL, AWS (ECS Fargate, RDS, ElastiCache, SNS/SQS, API Gateway + ALB), CDK in C# — see tech-plan.md.
- Resilience patterns only where a real failure point exists; the list and priority are in tech-plan.md.
- **AI-native.** Agents do most of the work here, so the docs are the source of truth: keep business-plan.md, tech-plan.md and README.md current as part of any change that moves a decision.
- Two environments, one codebase. Local = `docker compose` (Postgres, Redis, LocalStack via `AWS_ENDPOINT_URL`, all services, Vite proxy instead of API Gateway/ALB). AWS = CDK deploy. Only config differs; don't add environment-specific code paths.
- Build in the order of tech-plan.md's deployment milestones (under "Publishing to AWS"); its "Definition of done" is the acceptance bar.
- Default to the smallest thing that satisfies the business rule in business-plan.md. This repo exists to learn the infra patterns, not to build a full marketplace.
