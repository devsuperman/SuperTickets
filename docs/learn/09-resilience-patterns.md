# Resilience Patterns

**In one sentence:** Networks and dependencies fail, so every call to another system in SuperTickets has a time limit, a bounded retry, and (for the one that matters most) a circuit breaker, while optional pieces like Redis degrade gracefully and poison messages end up in a dead-letter queue instead of looping forever.

## The problem

Inventory's database stalls and each reserve call hangs. Order threads pile up waiting, users retry, retries add load, and soon Order is down too because it was waiting on a service that was already broken. Elsewhere a malformed message crashes its handler, is requeued, crashes again, and blocks the queue forever. A *cascading failure* turns one sick dependency into a whole-system outage.

## The concept

- **Timeout**: never wait forever; fail after a bound.
- **Retry with backoff and jitter**: retry transient errors, waiting longer each time (exponential backoff) and with random variation (jitter) so many clients do not retry in lockstep. Only safe when the call is idempotent ([06](06-idempotency.md)).
- **Circuit breaker**: after too many failures stop calling for a while and fail instantly.

```
        failures >= threshold
 CLOSED ───────────────────────▶ OPEN  (fail fast, no calls)
   ▲                               │ break duration elapsed
   │ probe succeeds                ▼
   └────────────────────────── HALF-OPEN (let one probe through)
                  probe fails ──▶ back to OPEN
```

- **Graceful degradation**: when an optional dependency fails, serve a reduced answer instead of an error.
- **Dead-letter queue (DLQ)**: after N failed deliveries a message is parked for inspection ([04](04-message-broker.md)).
- **Bulkhead**: isolate resources per dependency (separate pools) so one cannot starve the rest.
- **Health checks**: let orchestrators and humans see what is up.

## How SuperTickets applies it

Summary table: [tech-plan.md › Resilience patterns](../project/tech-plan.md#resilience-patterns).

**Timeout + retry + breaker, Order to Inventory.** Configured in [Order.Api/Program.cs](../../src/Order.Api/Program.cs) with `Microsoft.Extensions.Http.Resilience` (Polly v8), used by [`InventoryClient`](../../src/Order.Api/Common/InventoryClient.cs):

| Client | Strategies (outer to inner) | Values |
|---|---|---|
| `inventory-reserve` | retry, circuit breaker, timeout | 2 retries, 200 ms exponential; breaker: failure ratio 0.5, min throughput 5, 30 s sampling, 15 s break; 2 s timeout per attempt |
| `inventory-release` | retry, timeout | same retry and timeout, no breaker |

Retries trigger on `HttpRequestException`, timeouts and HTTP 5xx. A `409 sold_out` is not a failure, so it is never retried. Backoff is exponential; note that jitter is **not** enabled on these Polly retries (Polly's `UseJitter` option). Jitter is used where we did add it: cache TTL varies by +/-10 % ([03](03-caching.md)).

**`dependency_unavailable`.** When retries are exhausted or the breaker is open, `InventoryClient.Reserve` returns `ReserveResult.Unavailable` (an open breaker throws `BrokenCircuitException`, caught by `IsDependencyFailure`), and `CreateOrder` answers `503` with Problem Details `type: dependency_unavailable` via [`Problems.DependencyUnavailable`](../../src/Order.Api/Common/Problems.cs). The order stays `pending`: a retry with the same `Idempotency-Key` resumes at the reserve step, and the sweeper expires it otherwise ([07](07-saga-and-compensation.md)). Catalog has the same `503` when setting capacity fails, using retry and timeout only (no breaker): [Catalog Program.cs](../../src/Catalog.Api/Program.cs), [Problems.cs](../../src/Catalog.Api/Common/Problems.cs). The Worker's release call retries 3 times and then throws so the *message* is redelivered ([WorkerServices.cs](../../src/Worker/WorkerServices.cs)).

**Graceful degradation.** [`EventCache`](../../src/Catalog.Api/Common/EventCache.cs) catches every Redis exception, logs it and behaves as a miss, so `GET /events` still works from Postgres with `X-Cache: MISS`. Redis is configured to fail fast (`AbortOnConnectFail=false`, `BacklogPolicy.FailFast`, 1 s timeouts). `RedisCheck` reports Redis as *Degraded*, not Unhealthy, so the container stays in rotation ([HealthChecks.cs](../../src/Catalog.Api/Common/HealthChecks.cs)).

**DLQ.** Quorum queues with `x-delivery-limit`; a handler that throws makes `QueueConsumer.ProcessAsync` nack with requeue, and after 5 deliveries the broker dead-letters to `payment-dlq` / `notification-dlq` ([RabbitMq.cs](../../src/SuperTickets.Shared/Messaging/RabbitMq.cs), config `Messaging__MaxDeliveries`).

**Health checks.** `GET /health` on every service ([SuperTicketsDefaults.cs](../../src/SuperTickets.Shared/SuperTicketsDefaults.cs)); Compose `healthcheck` entries gate startup order with `depends_on: condition: service_healthy`.

## Try it

Make Inventory slow or failing with a Compose override (keys from [contracts.md › Configuration](../project/contracts.md#configuration)), then drive orders:

```bash
cat > /tmp/demo.yml <<'YML'
services:
  inventory-api:
    environment:
      Demo__ErrorRate: "1"      # or Demo__DelayMs: "3000" to trigger the 2 s timeout
YML
docker compose -f docker-compose.yml -f /tmp/demo.yml up -d --no-deps inventory-api
EV=$(curl -s localhost:8080/events | jq -r '.[0].id')
for i in 1 2 3 4 5; do
  curl -s -X POST localhost:8080/orders -H "Idempotency-Key: demo-$i-$RANDOM" -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"$EV\",\"quantity\":1,\"customerEmail\":\"a@b.com\"}" -w '  %{http_code} %{time_total}s\n'
done
docker compose logs order-api | grep -i "inventory reserve failed" | tail
```

The first requests take about a second (3 attempts with 200 ms and 400 ms waits); after roughly two failed requests the breaker opens and later ones return `503 dependency_unavailable` almost instantly. Stop failing (`docker compose up -d --no-deps --force-recreate inventory-api` without the override) and wait 15 s: the half-open probe succeeds and orders flow again. Other experiments: `docker compose stop redis` then `curl -si localhost:8080/events | grep -i x-cache` (MISS, still 200); `Demo__NotificationErrorRate: "1"` on `worker` to fill `notification-dlq` (see the RabbitMQ UI on :15672).

## Trade-offs and what we did NOT do

- **Bulkheads are not adopted** (listed in "Not adopted" in the tech plan): one shared HttpClient pool per dependency is enough at this scale.
- Breaker is only on reserve; release and Catalog's capacity call have retry + timeout only.
- Retrying a non-idempotent call would be dangerous; that is why reserve and release are keyed by `orderId`.
- Retries amplify load during an incident; the breaker is the counterweight. Redelivery of messages is immediate (no broker-level delay).
- No fallback for reserve: selling without checking stock would be wrong, so we fail honestly with 503.

## Check yourself

1. Why is the breaker placed inside the retry strategy rather than outside?
2. What status and `type` does a client see when Inventory is down, and what state is the order in?
3. Why is Redis unhealthy-but-optional modelled as *Degraded*?
4. What stops a poison message from looping forever?

<details><summary>Answers</summary>

1. Each attempt is recorded by the breaker, so repeated failures open it; an open breaker then makes subsequent attempts fail immediately instead of waiting.
2. `503`, `dependency_unavailable`; the order stays `pending` and can be resumed with the same key or is expired by the sweeper.
3. The app still works without it (reads Postgres), so the container should stay healthy and routable.
4. `x-delivery-limit` on the quorum queue: after 5 deliveries it moves to the DLQ.
</details>

## Further reading

- Michael Nygard, *Release It!* (circuit breaker, bulkhead, timeouts)
- Polly v8 documentation: resilience pipelines
- AWS Architecture Blog, "Exponential Backoff and Jitter"

Prev: [08 Concurrency](08-concurrency-and-inventory.md) · Next: [10 Observability and testing](10-observability-and-testing.md)
