# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

SuperTickets: minimal ticket-selling app built to exercise cache, message broker, load balancer, API gateway, and microservices patterns. Planning done, no code yet, so there are no build/test commands. When the first project lands, add its build, test, single-test, and `docker-compose` commands here.

## Docs

- Business rules and scope → [business-plan.md](business-plan.md)
- Architecture, resilience patterns, local Docker Compose stack → [tech-plan.md](tech-plan.md)
- AWS publish: service mapping, network, sizing, CDK stacks, deploy → [aws-publish.md](aws-publish.md)
- Exact routes, payloads, message schemas, DB tables, config keys, ports → [contracts.md](contracts.md)
- Work breakdown, dependencies, what can run in parallel → [tasks.md](tasks.md)
- [README.md](README.md) summarizes them (AI-native approach, flow, services, local run, AWS publish, resilience patterns)

Read the relevant one before proposing a change. When a decision changes, update that doc and check README.md's summary still matches — don't restate its content here.

## Conventions to hold onto

- **Vertical slices.** One project per service, one folder per feature under `Features/`. A feature talks straight to Postgres/Redis via `Common/`; events go out through the outbox table, not direct SNS publishes. Add an interface only when a specific feature needs one. The only shared projects are `SuperTickets.Shared` (plumbing) and `Order.Data` (Order DB, used by Order.Api and Worker).
- Stack is fixed: ASP.NET Core Minimal APIs (.NET 10), React + Vite, PostgreSQL, AWS (ECS Fargate, RDS, ElastiCache, SNS/SQS, API Gateway + ALB), CDK in C# — see tech-plan.md and aws-publish.md.
- Resilience patterns only where a real failure point exists; the list and priority are in tech-plan.md.
- **AI-native.** Agents do most of the work here, so the docs are the source of truth: keep business-plan.md, tech-plan.md, aws-publish.md, contracts.md and README.md current as part of any change that moves a decision.
- Two environments, one codebase. Local = `docker compose` (Postgres, Redis, LocalStack via `AWS_ENDPOINT_URL`, all services, Vite proxy instead of CloudFront/API Gateway/ALB). AWS = CDK deploy (aws-publish.md). Only config differs; keep AWS specifics out of tech-plan.md and the application code; don't add environment-specific code paths.
- Build by the tasks in tasks.md: one task per branch/PR, stay inside the paths the task owns, build against contracts.md and stub other services instead of waiting for them. A contract change goes into contracts.md in the same PR. The acceptance bar is the "Definition of done" in tech-plan.md (application) and aws-publish.md (published).
- Default to the smallest thing that satisfies the business rule in business-plan.md. This repo exists to learn the infra patterns, not to build a full marketplace.
