# AWS Publish

How SuperTickets is published to AWS: which service runs each piece, how traffic flows, what every CDK stack creates, and how the pipeline deploys it. The application itself (services, code structure, resilience patterns, local run) is in [tech-plan.md](tech-plan.md); the shared routes, config keys and routing rules are in [contracts.md](contracts.md).

The same container images and SPA build that run on `docker compose` are deployed here. Only configuration differs; nothing in the application code knows it is on AWS.

## Service mapping

| Piece | Local (Compose) | AWS |
|---|---|---|
| Catalog, Inventory, Order, Worker | containers | ECS Fargate services; images built and pushed to ECR by CDK (`ContainerImage.FromAsset`) |
| Database | `postgres` | Amazon RDS for PostgreSQL, one instance with the three databases |
| Cache | `redis` | Amazon ElastiCache for Redis |
| Broker | `localstack` (SNS + SQS) | Amazon SNS + SQS |
| Public entry point | Vite dev server proxy | CloudFront → API Gateway (HTTP API) |
| Load balancer | none (one instance each) | Internal Application Load Balancer, behind API Gateway via VPC Link |
| SPA hosting | Vite dev server | S3 + CloudFront |
| Secrets | plain values in `docker-compose.yml` | AWS Secrets Manager |
| IaC | — | AWS CDK in C# (`net10.0`) |
| CI/CD | — | GitHub Actions: build and test on every PR; `cdk deploy --all` on `main` via OIDC |

## Request path

```
Browser
   │
   ▼
CloudFront ──(default)──▶ S3 (SPA)
   │ /events*, /orders*, /admin/*
   ▼
Amazon API Gateway (HTTP API, throttled)
   │  VPC Link
   ▼
Internal ALB  ──▶ ECS Fargate: Catalog Service (2 tasks, round-robin)
             ──▶ ECS Fargate: Order Service
             ──▶ ECS Fargate: Inventory Service ◀── Catalog, Order, Worker (/inventory/*)

ECS Fargate: Worker (no ingress) ◀── SQS ◀── SNS ◀── Order Service (outbox publisher)
All tasks ──▶ RDS (Postgres); Catalog ──▶ ElastiCache (Redis)
```

- **CloudFront** serves the SPA and forwards API paths (no caching) to API Gateway, so the browser only ever talks to one origin: no CORS, no API URL baked into the build. A CloudFront Function rewrites SPA routes to `/index.html` (not an error-page rule, which would also swallow API 404s).
- **API Gateway** owns the public surface: explicit routes only, plus throttling. HTTP APIs do not support API keys, so the admin key is checked by the Catalog Service itself, the same way as locally.
- **ALB** distributes traffic across task instances; Catalog runs 2 tasks. `/inventory/*` is reachable on the ALB but has no API Gateway route, so it stays internal.
- **Worker** runs as an ECS service with no ingress. It only polls SQS.

## Network

| Item | Spec |
|---|---|
| VPC | 2 AZs, public + private subnets |
| NAT | 1 NAT gateway (tasks pull images and reach SNS/SQS through it) |
| ECS tasks | private subnets, no public IP |
| RDS, ElastiCache | private subnets |
| ALB | internal, private subnets |
| VPC Link | into the private subnets, targets the ALB listener |

Security groups:

| Group | Inbound from |
|---|---|
| `vpc-link-sg` | — (outbound to `alb-sg` on 80) |
| `alb-sg` | `vpc-link-sg` and `tasks-sg` on 80 (tasks call Inventory through the ALB) |
| `tasks-sg` | `alb-sg` on 8080 |
| `db-sg` | `tasks-sg` on 5432 |
| `cache-sg` | `tasks-sg` on 6379 |

## Sizing

Smallest sizes that run the demo; raise them only if something is actually slow.

| Resource | Spec |
|---|---|
| Fargate tasks | 0.25 vCPU / 512 MB each, Linux x86_64 |
| Desired count | Catalog 2, Inventory 1, Order 1, Worker 1 |
| RDS | PostgreSQL 17, `db.t4g.micro`, 20 GB gp3, single-AZ, 1-day backups, deletion protection off |
| ElastiCache | Redis 7, `cache.t4g.micro`, 1 node, no replicas |
| SQS | as in [contracts.md](contracts.md#messages): visibility 30 s, `maxReceiveCount` 5, DLQ retention 14 days |
| Logs | CloudWatch Logs, one group per service, 7-day retention |

## Configuration on AWS

The keys are the ones in [contracts.md](contracts.md#configuration); this is where their AWS values come from.

| Key | Source on AWS |
|---|---|
| `ConnectionStrings__Catalog` / `__Inventory` / `__Orders` | `Host=<rds endpoint>;Database=<db>;Username=postgres` (no password) |
| `PGPASSWORD` | ECS secret from the RDS-generated Secrets Manager secret (`password` field) |
| `ConnectionStrings__Redis` | `<elasticache endpoint>:6379` |
| `Services__InventoryUrl` | `http://<internal alb dns>` |
| `Messaging__TopicArn` | SNS topic ARN |
| `Messaging__PaymentQueueUrl`, `Messaging__NotificationQueueUrl` | SQS queue URLs |
| `Admin__ApiKey` | ECS secret from a CDK-generated Secrets Manager secret |
| `AWS_REGION` | the stack's region |
| `AWS_ENDPOINT_URL`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | not set; the SDK uses the task role |
| `Payment__FailureRate`, `Demo__*` | same defaults as local; change in the task definition to demo failures |

## IAM

| Role | Permissions |
|---|---|
| Order task role | `sns:Publish` on the topic |
| Worker task role | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` on its two queues |
| Catalog, Inventory task roles | none beyond the defaults |
| Task execution role (all) | pull from ECR, write logs, read the two secrets |
| GitHub deploy role | assumed via OIDC from this repo's `main` branch only; permission to assume the CDK bootstrap roles |

## Routing

API Gateway routes and ALB listener rules follow the [routing table](contracts.md#routing):

| ALB priority | Path | Target group |
|---|---|---|
| 1 | `/events/*/availability` | inventory |
| 2 | `/inventory/*` | inventory |
| 3 | `/events`, `/events/*`, `/admin/*` | catalog |
| 4 | `/orders`, `/orders/*` | order |
| default | — | fixed 404 |

Each target group health-checks `GET /health` on 8080.

API Gateway (HTTP API) has exactly the seven public routes from contracts.md, each integrated with the ALB listener through the VPC Link. Default stage throttling: 50 requests/s, burst 100.

CloudFront behaviors:

| Path | Origin | Cache | Origin request policy |
|---|---|---|---|
| `/events*`, `/orders*`, `/admin/*` | API Gateway | disabled | `AllViewerExceptHostHeader` |
| default (`*`) | S3 (Origin Access Control) | optimized | — (+ SPA rewrite function) |

## CDK stacks

One file per stack in `infra/cdk/SuperTickets.Cdk/`, so they can be built in parallel. Cross-stack values are passed as constructor props, not by name lookups.

| Stack | Creates | Needs |
|---|---|---|
| `DataStack` | VPC, NAT, security groups, RDS + secret, ElastiCache | — |
| `MessagingStack` | SNS topic, `payment-queue`, `notification-queue`, DLQs, raw-delivery subscriptions with `eventType` filters | — |
| `ServicesStack` | ECS cluster, 4 Fargate services from the repo Dockerfiles, admin key secret, internal ALB, target groups, listener rules, IAM, log groups | Data, Messaging |
| `ApiStack` | HTTP API, VPC Link, routes, throttling | Services (ALB listener) |
| `WebStack` | private S3 bucket, CloudFront distribution + SPA rewrite function, `BucketDeployment` of `src/web/dist` with invalidation | Api (API domain) |

Stack outputs: the CloudFront URL, the API Gateway URL, and the DLQ URLs.

## Deploying

One-time setup per account and region:
1. `cdk bootstrap aws://<account>/<region>`.
2. Create the GitHub OIDC provider and deploy role (by hand or with a small bootstrap stack; T17 decides and documents it here).
3. Set the repo variables `AWS_ROLE_ARN` and `AWS_REGION`.

Every deploy, from the pipeline or a laptop with credentials:
```
cd src/web && npm ci && npm run build
cd ../../infra/cdk && cdk deploy --all --require-approval never
```

`FromAsset` builds and pushes the four images during `cdk deploy`, and `BucketDeployment` uploads the SPA and invalidates CloudFront, so there is no separate image or upload step.

Tear down with `cdk destroy --all` when not in use. RDS, ElastiCache and the NAT gateway cost money while idle.

## Deployment milestones

The order things first work on AWS. [tasks.md](tasks.md) schedules the work behind them in parallel.

1. `DataStack`: VPC, RDS (Postgres), ElastiCache (Redis).
2. Catalog Service → ECS Fargate, backed by Redis cache.
3. Inventory Service → ECS Fargate.
4. Order Service → ECS Fargate + SNS topic.
5. Payment/Notification Worker → ECS Fargate service (no ingress) + 2 SQS queues, each with a DLQ.
6. Internal ALB in front of the services, Catalog on 2 tasks.
7. API Gateway (HTTP API) with VPC Link to the ALB.
8. React SPA → S3 + CloudFront, forwarding API paths to API Gateway.
9. GitHub Actions pipeline for the .NET services and the SPA.

## Definition of done

Everything in [tech-plan.md's Definition of done](tech-plan.md#definition-of-done-application), checked through the CloudFront URL, plus:

- All public traffic goes through API Gateway; `/inventory/*` is not reachable from outside.
- Requests are distributed across 2 Catalog tasks behind the ALB.
- A merge to `main` deploys without manual steps.

## Out of scope

Multi-AZ RDS, autoscaling policies, WAF, Cognito/real auth, custom domain/ACM certificate, VPC endpoints instead of the NAT gateway, blue/green deployments.
