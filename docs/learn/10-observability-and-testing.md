# Observability and Testing

**In one sentence:** SuperTickets makes a distributed request traceable with one correlation ID carried through HTTP headers, message properties and log scopes, exposes `/health`, `X-Cache` and `X-Upstream` so you can see what happened, and proves the hard behaviors with Testcontainers integration tests, fake HTTP stubs and an end-to-end smoke script.

## The problem

A customer says "my order is stuck". The request went through nginx, Order, Inventory, the outbox, RabbitMQ and the Worker. Each service logged something, but there is no way to tell which lines belong to that order. And without tests that run real Postgres and RabbitMQ, bugs like the last-ticket race or a duplicated message only show up in production.

## The concept

- **Correlation ID**: one opaque ID created at the edge and propagated everywhere; filter logs by it to see a whole journey. (Full distributed tracing, e.g. OpenTelemetry, is the heavier version.)
- **Health endpoint**: a cheap "am I able to work?" probe for orchestrators and humans.
- **Visible behavior headers**: responses that reveal internals (cache hit, which replica).
- **Integration tests with real infrastructure**: containers for Postgres, Redis, RabbitMQ so SQL and broker semantics are real; **stubs** for *other* services so a test stays about one service.
- **End-to-end smoke test**: a script against the running stack that checks the Definition of done.

```
client ─X-Correlation-Id─▶ nginx ─▶ Order ─header─▶ Inventory
                                      │ outbox.correlation_id
                                      ▼
                           RabbitMQ  CorrelationId property ─▶ Worker (log scope)
```

## How SuperTickets applies it

**Correlation ID flow.** [CorrelationId.cs](../../src/SuperTickets.Shared/CorrelationId.cs):
1. nginx forwards `X-Correlation-Id` ([nginx.conf](../../infra/nginx/nginx.conf)).
2. `CorrelationIdMiddleware` reuses the header (or generates a GUID if missing or longer than 100 chars), stores it in `CorrelationContext.Current` (an `AsyncLocal`), echoes it on the response and opens a logging scope `{CorrelationId}`.
3. `CorrelationIdHandler` is added to every `HttpClient` by `AddSuperTicketsDefaults`, so Order to Inventory calls carry it.
4. The outbox row stores `correlation_id`; [`OutboxPublisher`](../../src/SuperTickets.Shared/Messaging/OutboxPublisher.cs) sets it as the AMQP `CorrelationId` (also `MessageId` = outbox id, header `eventType`).
5. [`QueueConsumer`](../../src/SuperTickets.Shared/Messaging/QueueConsumer.cs) restores `CorrelationContext.Current` from the message and opens a log scope before calling the handler. Contract: [contracts.md › Messages](../project/contracts.md#messages).

**`/health`.** Every service maps `GET /health` in `UseSuperTicketsDefaults`; Catalog and Order add `PostgresCheck`, Catalog also `RedisCheck` (degraded, not unhealthy), see [HealthChecks.cs](../../src/Catalog.Api/Common/HealthChecks.cs). Compose probes it ([docker-compose.yml](../../docker-compose.yml)).

**Headers.** `X-Cache: HIT|MISS` is set in [GetEvent.cs](../../src/Catalog.Api/Features/GetEvent/GetEvent.cs) and `ListEvents`; `X-Upstream` is added by nginx ([02](02-api-gateway-and-load-balancer.md), [03](03-caching.md)).

**Tests** (xUnit; layout in [tech-plan.md › Testing](../project/tech-plan.md#testing)):
- Real infrastructure via Testcontainers: `Infra` in [CatalogFactory.cs](../../tests/Catalog.Api.Tests/CatalogFactory.cs) (Postgres + Redis), `WorkerInfra` ([WorkerInfra.cs](../../tests/Worker.Tests/WorkerInfra.cs): Postgres + RabbitMQ), `MessagingInfra` in `SuperTickets.Shared.Tests`.
- Other services stubbed with a fake `HttpMessageHandler`: `FakeInventory` in [OrderFactory.cs](../../tests/Order.Api.Tests/OrderFactory.cs) lets a test flip `Reserve` to return 500 or 409 and count calls; `OrderFactory : WebApplicationFactory<Program>` swaps it in as the primary handler.
- The required tests:

| Required test | Where |
|---|---|
| Last-ticket race (one winner) | `Twenty_parallel_reserves_for_one_ticket_yield_one_201` in [InventoryTests.cs](../../tests/Inventory.Api.Tests/InventoryTests.cs) |
| Replay of idempotent ops | `Reserve_replay_is_a_noop`, `Release_restores_stock_and_replay_is_a_noop` (Inventory); `Same_key_gives_one_order_and_one_outbox_row` ([OrderTests.cs](../../tests/Order.Api.Tests/OrderTests.cs)); `Duplicate_OrderCreated_gives_one_payment_and_one_event`, `Duplicate_PaymentSucceeded_creates_quantity_tickets` ([WorkerTests.cs](../../tests/Worker.Tests/WorkerTests.cs)) |
| Redis-down fallback | `Redis_down_falls_back_to_postgres_with_MISS` ([CatalogTests.cs](../../tests/Catalog.Api.Tests/CatalogTests.cs)) |

- Resilience: `Inventory_down_gives_503_then_same_key_retry_succeeds` and `Breaker_opens_and_fails_fast` (Order); `Throwing_handler_moves_message_to_DLQ_after_5_receives` (Worker). Correlation: `Outgoing_handler_forwards_correlation_id` in [DefaultsTests.cs](../../tests/SuperTickets.Shared.Tests/DefaultsTests.cs).

**Smoke script and Definition of done.** [scripts/smoke.sh](../../scripts/smoke.sh) runs against the gateway and checks: events listed, order to paid with tickets, last-ticket race (`202 409`), cache HIT/MISS, `/inventory/*` 404, GETs spread over 2 replicas, and (with toggles) forced payment failure restoring stock and forced notification failure reaching `notification-dlq`. The full list is [tech-plan.md › Definition of done](../project/tech-plan.md#definition-of-done).

## Try it

```bash
dotnet test                                   # needs Docker for Testcontainers
dotnet test --filter "FullyQualifiedName~Redis_down"
docker compose up --build -d --wait
scripts/smoke.sh --no-toggles                 # fast; without the flag it restarts the worker (~1-2 min)

# follow one request across services
EV=$(curl -s localhost:8080/events | jq -r '.[0].id')
curl -si -X POST localhost:8080/orders -H 'X-Correlation-Id: trace-me-1' -H "Idempotency-Key: k-$RANDOM" \
  -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"quantity\":1,\"customerEmail\":\"a@b.com\"}" | head -n 12
docker compose logs | grep trace-me-1         # order-api, inventory-api, worker lines
curl -s localhost:8080/events/$EV/availability -o /dev/null -D - | grep -i x-upstream
curl -si localhost:5103/health                # order-api via its host port
docker compose stop redis && curl -si localhost:8080/events | grep -i x-cache
```

## Trade-offs and what we did NOT do

- Correlation IDs give grep-able logs, not spans, timings or a trace UI (no OpenTelemetry, "full tracing" is in the not-adopted list).
- Logs are plain console output; no aggregation, metrics or alerting.
- `/health` checks Postgres (and Redis as degraded) but not RabbitMQ or Inventory reachability; a green `/health` is not proof the whole flow works. Hence the smoke test.
- Unit tests are few by design: behavior is tested through HTTP and the broker with real containers, which is slower but catches SQL and broker semantics.
- Stubs return contract-shaped responses, so a contract change must update [contracts.md](../project/contracts.md) and the stubs together.

## Check yourself

1. Where is the correlation ID stored between the HTTP request and the message the Worker receives?
2. Why is Inventory faked in Order tests but Postgres is real?
3. Which test proves two concurrent buyers cannot both get the last ticket?
4. What does a smoke test catch that the integration tests cannot?

<details><summary>Answers</summary>

1. In the outbox row's `correlation_id`, then the AMQP `CorrelationId` property the consumer reads back.
2. A fake isolates the test to Order's logic and lets it simulate failures; real Postgres is needed because correctness depends on SQL constraints and transactions.
3. `Twenty_parallel_reserves_for_one_ticket_yield_one_201` (and `smoke.sh` repeats it through the gateway).
4. Wiring across the real deployment: nginx routes, Docker DNS, compose config, all services and the broker together.
</details>

## Further reading

- OpenTelemetry and W3C Trace Context (`traceparent`)
- Testcontainers documentation
- Google SRE book, "Monitoring Distributed Systems" (the four golden signals)

Prev: [09 Resilience](09-resilience-patterns.md) · See also: [case-studies.md](case-studies.md)
