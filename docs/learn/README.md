# Learn distributed systems with SuperTickets

SuperTickets is small on purpose: every pattern here exists because a real failure point needs it. Each guide follows the same shape: the problem, the concept, how this repo applies it (with code links), commands to try, trade-offs, and self-check questions.

![System design](../diagrams/system-design.svg)

## Suggested order

| # | Guide | Concept | Where it lives |
|---|---|---|---|
| 1 | [Microservices and Vertical Slice](01-microservices-and-vertical-slice.md) | Service boundaries, DB per service, feature folders | `src/*` |
| 2 | [API gateway and load balancer](02-api-gateway-and-load-balancer.md) | Routing, rate limit, round-robin | `infra/nginx/nginx.conf` |
| 3 | [Caching](03-caching.md) | Cache-aside, TTL jitter, graceful degradation | `src/Catalog.Api` |
| 4 | [Message broker](04-message-broker.md) | Exchange, queues, ack, DLQ | `src/SuperTickets.Shared/Messaging`, `src/Worker` |
| 5 | [Transactional outbox](05-transactional-outbox.md) | Avoiding the dual write | `Outbox*.cs`, `Order.Api` |
| 6 | [Idempotency](06-idempotency.md) | Safe retries and redelivery | Orders, Inventory, Worker |
| 7 | [Saga and compensation](07-saga-and-compensation.md) | Undoing work across services | Order, Worker, sweeper |
| 8 | [Concurrency and inventory](08-concurrency-and-inventory.md) | No overselling | `src/Inventory.Api` |
| 9 | [Resilience patterns](09-resilience-patterns.md) | Timeout, retry, circuit breaker | Order → Inventory client |
| 10 | [Observability and testing](10-observability-and-testing.md) | Correlation ID, health, Testcontainers, smoke | `tests/`, `scripts/smoke.sh` |

Then do the hands-on lab: [Case studies](case-studies.md) (break the system on purpose and watch each pattern respond).

## How to study

1. Read the guide, then open the linked code.
2. Run the stack: `docker compose up --build -d --wait` (app at http://localhost:8080, RabbitMQ UI at http://localhost:15672, guest/guest).
3. Do the guide's **Try it** section, then answer **Check yourself** without looking.
4. Finish with the matching scenario in [case-studies.md](case-studies.md).

Authoritative specs (routes, schemas, config, flows) are in [../project/](../project/); the guides link to them rather than repeat them.
