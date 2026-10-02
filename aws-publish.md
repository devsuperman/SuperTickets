# AWS Publish

AWS infrastructure for the same images and SPA build used locally. App design: [tech-plan.md](tech-plan.md). Keys and routes: [contracts.md](contracts.md).

## Mapping

| Piece | Local | AWS |
|---|---|---|
| APIs + Worker | Compose containers | ECS Fargate; images via CDK `ContainerImage.FromAsset` |
| Database | `postgres` | RDS PostgreSQL |
| Cache | `redis` | ElastiCache Redis |
| Broker | LocalStack | SNS + SQS |
| Entry point | Vite proxy | CloudFront → API Gateway (HTTP API) |
| Load balancer | — | Internal ALB via VPC Link |
| SPA | Vite dev server | S3 + CloudFront |
| Secrets | `docker-compose.yml` | Secrets Manager |
| IaC / CI/CD | — | CDK (C#) / GitHub Actions + OIDC |

## Request path

```
Browser → CloudFront ─(default)→ S3 (SPA)
              │ /events*, /orders*, /admin/*
              ▼
         API Gateway (HTTP API) ─VPC Link→ internal ALB ─→ Catalog ×2, Order, Inventory
Order ─→ SNS ─→ SQS ─→ Worker (no ingress)
Catalog, Order, Worker ─→ ALB /inventory/* ─→ Inventory
```

- CloudFront: one origin for the browser (no CORS). A CloudFront Function rewrites SPA routes to `/index.html`; don't use error-page rules (they would hide API 404s).
- API Gateway: public routes + throttling. HTTP APIs have no API keys, so Catalog checks the admin key.
- `/inventory/*` exists only on the ALB.

## Network

- VPC: 2 AZs, public + private subnets, 1 NAT gateway.
- Tasks, RDS, ElastiCache, ALB: private subnets, no public IPs.

| Security group | Inbound |
|---|---|
| `alb-sg` | `vpc-link-sg`, `tasks-sg` on 80 |
| `tasks-sg` | `alb-sg` on 8080 |
| `db-sg` | `tasks-sg` on 5432 |
| `cache-sg` | `tasks-sg` on 6379 |

## Sizing

| Resource | Spec |
|---|---|
| Fargate | 0.25 vCPU / 512 MB; Catalog 2 tasks, others 1 |
| RDS | PostgreSQL 17, `db.t4g.micro`, 20 GB gp3, single-AZ |
| ElastiCache | Redis 7, `cache.t4g.micro`, 1 node |
| SQS | per [contracts.md](contracts.md#messages); DLQ retention 14 days |
| Logs | CloudWatch, 7 days |

## Configuration

AWS values for the keys in [contracts.md](contracts.md#configuration):

| Key | Value |
|---|---|
| `ConnectionStrings__*` (DB) | `Host=<rds>;Database=<db>;Username=postgres` (no password) |
| `PGPASSWORD` | ECS secret from the RDS secret |
| `ConnectionStrings__Redis` | `<elasticache>:6379` |
| `Services__InventoryUrl` | `http://<alb dns>` |
| `Messaging__*` | topic ARN, queue URLs |
| `Admin__ApiKey` | ECS secret (CDK-generated) |
| `AWS_REGION` | stack region |
| `AWS_ENDPOINT_URL`, access keys | unset (task role) |

## IAM

| Role | Permissions |
|---|---|
| Order task | `sns:Publish` on the topic |
| Worker task | `sqs:ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` on its queues |
| Execution (all) | ECR pull, logs, read the two secrets |
| GitHub deploy | OIDC, `main` only; assume CDK bootstrap roles |

## Routing

| ALB priority | Path | Target |
|---|---|---|
| 1 | `/events/*/availability` | inventory |
| 2 | `/inventory/*` | inventory |
| 3 | `/events`, `/events/*`, `/admin/*` | catalog |
| 4 | `/orders`, `/orders/*` | order |
| default | — | 404 |

- Target groups health-check `/health` on 8080.
- API Gateway: the seven public routes only; throttling 50 rps, burst 100.
- CloudFront: API paths → API Gateway (no cache, `AllViewerExceptHostHeader`); default → S3 via OAC.

## CDK stacks

`infra/cdk/SuperTickets.Cdk/`, one file per stack, values passed as props.

| Stack | Creates | Needs |
|---|---|---|
| `DataStack` | VPC, NAT, security groups, RDS + secret, ElastiCache | — |
| `MessagingStack` | Topic, queues, DLQs, filtered subscriptions | — |
| `ServicesStack` | ECS cluster, 4 services, admin secret, ALB + rules, IAM, logs | Data, Messaging |
| `ApiStack` | HTTP API, VPC Link, routes, throttling | Services |
| `WebStack` | S3, CloudFront + function, `BucketDeployment` of `src/web/dist` | Api |

Outputs: CloudFront URL, API URL, DLQ URLs.

## Deploy

One-time setup:

1. `cdk bootstrap aws://<account>/<region>`.
2. Create the IAM OIDC provider `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`).
3. Create an IAM role trusted by that provider with condition `token.actions.githubusercontent.com:sub` = `repo:<owner>/SuperTickets:ref:refs/heads/main` (and `:aud` = `sts.amazonaws.com`). Its only permission is `sts:AssumeRole` on the CDK bootstrap roles (`arn:aws:iam::<account>:role/cdk-*`).
4. Set repo variables `AWS_ROLE_ARN` (that role) and `AWS_REGION`.

`.github/workflows/deploy.yml` runs on every push to `main`: assume the role via OIDC, build the SPA, then run the commands below.

```
cd src/web && npm ci && npm run build
cd ../../infra/cdk && cdk deploy --all --require-approval never
```

CDK builds/pushes images and uploads the SPA with invalidation. Tear down with `cdk destroy --all` — RDS, ElastiCache and NAT cost money while idle.

## Definition of done

[tech-plan.md checks](tech-plan.md#definition-of-done) pass through the CloudFront URL, plus:

- Public traffic only via API Gateway; `/inventory/*` unreachable from outside.
- Traffic spreads across 2 Catalog tasks.
- Merge to `main` deploys with no manual step.

## Out of scope

Multi-AZ RDS, autoscaling, WAF, real auth, custom domain, VPC endpoints, blue/green.
