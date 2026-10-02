# Case studies: break it on purpose

A hands-on lab. Each scenario starts the stack, makes one thing go wrong (or right) on purpose, and shows what you should see and why. Every command goes through the gateway at `http://localhost:8080` unless noted.

Verification status: behaviour below was checked by reading the code and config (links in each scenario). The README notes the Compose stack had not yet been run end to end when this was written, so exact log lines, timings and counts are expectations, not recordings. Places where I could not confirm something are marked **(unverified)**.

## Map: scenarios, concepts, guides

| # | Scenario | Concept | Guide |
|---|---|---|---|
| 1 | Happy path purchase | Microservices, gateway, outbox, broker, saga happy path | [01](01-microservices-and-vertical-slice.md), [04](04-message-broker.md), [05](05-transactional-outbox.md) |
| 2 | Cache hit vs miss, invalidation | Cache-aside, TTL jitter, version-key invalidation | [03](03-caching.md) |
| 3 | Redis down | Graceful degradation | [03](03-caching.md), [09](09-resilience-patterns.md) |
| 4 | Two Catalog replicas, rate limit | Load balancing, round-robin, rate limiting | [02](02-api-gateway-and-load-balancer.md) |
| 5 | Last-ticket race | Atomic conditional update, no overselling | [08](08-concurrency-and-inventory.md) |
| 6 | Client retry, same Idempotency-Key | Idempotent API | [06](06-idempotency.md) |
| 7 | Payment failure | Saga compensation | [07](07-saga-and-compensation.md) |
| 8 | Slow or failing Inventory | Timeout, retry, circuit breaker | [09](09-resilience-patterns.md) |
| 9 | Poison message | Retries, dead-letter queue | [04](04-message-broker.md), [09](09-resilience-patterns.md) |
| 10 | Worker crash, lost message | Expiry sweeper, state-guarded updates | [07](07-saga-and-compensation.md), [09](09-resilience-patterns.md) |
| 11 | RabbitMQ down | Transactional outbox | [05](05-transactional-outbox.md) |
| 12 | Duplicate delivery | Idempotent consumers | [06](06-idempotency.md), [04](04-message-broker.md) |

Observability for all of them (correlation IDs, health, SQL and RabbitMQ views): [10-observability-and-testing.md](10-observability-and-testing.md).

## Before you start

Requirements: Docker with Compose, `curl`, `jq`.

```bash
cd SuperTickets
docker compose up --build -d --wait
```

Entry points: app and API `http://localhost:8080`, RabbitMQ UI `http://localhost:15672` (guest/guest), Postgres `localhost:5432` (postgres/postgres), Redis `localhost:6379`. Ports and routes: [contracts.md](../project/contracts.md#ports).

Paste these helpers into your shell once (they are used in every scenario):

```bash
export BASE=http://localhost:8080
future() { date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ; }

# new_event NAME TOTAL  -> prints the event id
new_event() {
  curl -s -X POST $BASE/admin/events \
    -H 'X-Api-Key: dev-admin-key' -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"venue\":\"Lab Arena\",\"startsAt\":\"$(future)\",\"totalTickets\":$2,\"price\":25.00}" | jq -r .id
}
# place_order IDEMPOTENCY_KEY EVENT_ID [QTY]  -> prints status line, headers and body
place_order() {
  curl -s -i -X POST $BASE/orders \
    -H "Idempotency-Key: $1" -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"$2\",\"quantity\":${3:-1},\"customerEmail\":\"lab@example.com\"}"
}
avail()      { curl -s $BASE/events/$1/availability | jq .available; }
order_json() { curl -s $BASE/orders/$1 | jq -c '{status,cancelReason,tickets:(.tickets|length)}'; }
sql_orders() { docker compose exec -T postgres psql -U postgres -d orders -c "$1"; }
sql_inv()    { docker compose exec -T postgres psql -U postgres -d inventory -c "$1"; }
```

### Changing config (env toggles)

`docker-compose.yml` hard-codes the toggle values (for example `Payment__FailureRate: "0.1"`), so a `VAR=x docker compose up` prefix does **not** work. Use a Compose override file instead. Compose merges `environment` maps per key, so you only list what you change:

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  worker:
    environment:
      Payment__FailureRate: "0"
EOF
docker compose up -d --no-deps --no-build --force-recreate worker   # recreate only the changed service
```

`docker-compose.override.yml` is loaded automatically and is not git-ignored: delete it when you finish a scenario and recreate the service to restore defaults, and never commit it.

```bash
rm -f docker-compose.override.yml
docker compose up -d --no-deps --no-build --force-recreate worker inventory-api order-api
```

All toggles are documented in [contracts.md › Configuration](../project/contracts.md#configuration). `scripts/smoke.sh` uses the same override mechanism (a temp file with `-f`) for its failure checks; read it as a worked example.

### Handy queries

```bash
# orders DB (orders, payments, tickets, outbox)
docker compose exec postgres psql -U postgres -d orders
# inventory DB (stock, reservations)
docker compose exec postgres psql -U postgres -d inventory
# redis
docker compose exec redis redis-cli
# queue depths without the UI
curl -s -u guest:guest http://localhost:15672/api/queues/%2F | jq -r '.[] | "\(.name)\t\(.messages)"'
```

---

## 1. Happy path purchase end to end

**Goal.** See the whole flow once, so every later failure has something to be compared with: gateway, Catalog, Inventory, Order, outbox, RabbitMQ, Worker. Guides: [01](01-microservices-and-vertical-slice.md), [04](04-message-broker.md), [05](05-transactional-outbox.md).

**Setup.** Make payment deterministic (default is a 10 % random decline):

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  worker:
    environment:
      Payment__FailureRate: "0"
EOF
docker compose up -d --no-deps --no-build --force-recreate worker
```

**Steps.**

```bash
EID=$(new_event "Lab 1" 10); echo $EID
avail $EID                                   # 10 (Catalog pushed capacity to Inventory)

place_order lab1-a $EID 2                    # 202, "status":"pending"
OID=<id from the response body>
sleep 3; order_json $OID                     # {"status":"paid",...,"tickets":2}
avail $EID                                   # 8

sql_orders "select id,status,cancel_reason from orders where id='$OID'"
sql_orders "select * from payments where order_id='$OID'"
sql_orders "select number,status from tickets where order_id='$OID' order by number"
sql_orders "select type,published_at is not null as published,correlation_id from outbox order by created_at desc limit 3"
sql_inv    "select * from reservations where order_id='$OID'"

docker compose logs --tail=20 worker         # "Confirmation sent to lab@example.com: order ..., 2 ticket(s)"
```

In the RabbitMQ UI, Queues tab: `payment-queue`, `notification-queue`, `payment-dlq`, `notification-dlq` exist; message rates blip for a second, DLQs stay at 0.

**Expected result.**

- `POST /orders` returns `202` with `status: pending` immediately; the response carries `X-Correlation-Id` and `X-Upstream`.
- Within a few seconds the order is `paid` with tickets numbered 1 and 2, availability dropped by 2, one `payments` row (`succeeded = t`), an active reservation, and two outbox rows (`OrderCreated`, `PaymentSucceeded`) both with `published_at` set. The `PaymentFailed` type never appears.

**What happened under the hood.**

1. `new_event` (`POST /admin/events`): nginx matches `/admin` and proxies to a Catalog replica ([nginx.conf](../../infra/nginx/nginx.conf)). Catalog validates, calls Inventory `PUT /inventory/events/{id}` first (upsert stock), then saves the event, then invalidates cache ([CreateEvent.cs](../../src/Catalog.Api/Features/CreateEvent/CreateEvent.cs)).
2. `GET /events/{id}/availability` is matched first by nginx and sent straight to Inventory, not Catalog.
3. `POST /orders` hits Order. It inserts `orders` row `pending` with the idempotency key ([CreateOrder.cs](../../src/Order.Api/Features/CreateOrder/CreateOrder.cs)).
4. Order calls Inventory `POST /inventory/reservations` (timeout, retry, breaker). Inventory inserts a `reservations` row and runs `UPDATE stock ... WHERE available >= qty` in one transaction ([ReserveStock.cs](../../src/Inventory.Api/Features/ReserveStock/ReserveStock.cs)).
5. Order writes `OrderCreated` into the `outbox` table and returns 202. No broker call happens in the request.
6. The outbox publisher in Order.Api polls every second, locks unpublished rows with `FOR UPDATE SKIP LOCKED`, publishes to exchange `supertickets-events` with routing key `OrderCreated`, then sets `published_at` ([OutboxPublisher.cs](../../src/SuperTickets.Shared/Messaging/OutboxPublisher.cs)).
7. The exchange routes it to `payment-queue`. The Worker's `PaymentConsumer` polls the queue, and in one transaction updates the order to `paid` (only `WHERE status = 'pending'`), inserts the `payments` row and a `PaymentSucceeded` outbox row, then acks ([PaymentConsumer.cs](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs)).
8. The same Order.Api publisher (it publishes every row in the shared `orders` DB, including Worker rows) sends `PaymentSucceeded` to `notification-queue`.
9. `NotificationConsumer` inserts tickets `1..quantity` with `ON CONFLICT DO NOTHING`, logs the confirmation, acks ([NotificationConsumer.cs](../../src/Worker/Features/SendNotification/NotificationConsumer.cs)).
10. `GET /orders/{id}` now returns `paid` plus tickets.

Reset the override when done (see "Changing config").

---

## 2. Cache hit vs miss (X-Cache) and invalidation after an admin update

**Goal.** Watch cache-aside and how an admin write invalidates it. Guide: [03-caching.md](03-caching.md).

**Setup.** Defaults (`Cache__TtlSeconds: "60"`). To have more time to poke around, raise it with an override on `catalog-api` (`Cache__TtlSeconds: "300"`) and `docker compose up -d --no-deps --no-build --force-recreate catalog-api`.

**Steps.**

```bash
EID=$(new_event "Lab 2" 10)

curl -si $BASE/events/$EID | grep -i -E '^(x-cache|x-upstream)'     # X-Cache: MISS
curl -si $BASE/events/$EID | grep -i -E '^(x-cache|x-upstream)'     # X-Cache: HIT
curl -si "$BASE/events?search=lab+2" | grep -i x-cache              # MISS
curl -si "$BASE/events?search=lab+2" | grep -i x-cache              # HIT

docker compose exec redis redis-cli --scan --pattern 'catalog:*'
docker compose exec redis redis-cli get catalog:version
docker compose exec redis redis-cli ttl catalog:event:$EID          # roughly 54-66 with the default TTL

# admin update (full replace)
curl -s -X PUT $BASE/admin/events/$EID \
  -H 'X-Api-Key: dev-admin-key' -H 'Content-Type: application/json' \
  -d "{\"name\":\"Lab 2 renamed\",\"venue\":\"Lab Arena\",\"startsAt\":\"$(future)\",\"totalTickets\":10,\"price\":30.00}" | jq .name

curl -si $BASE/events/$EID | grep -i x-cache                        # MISS (key was deleted)
curl -si $BASE/events/$EID | grep -i x-cache                        # HIT with the new name
curl -si "$BASE/events?search=lab+2" | grep -i x-cache              # MISS (version bumped)
docker compose exec redis redis-cli get catalog:version             # one higher than before
docker compose exec redis redis-cli --scan --pattern 'catalog:*'    # old catalog:v<N>:events:... key lingers until its TTL
```

**Expected result.** MISS, HIT, then after the update MISS, HIT again, for both the single event and the list. The `X-Upstream` of the two GETs may differ (different replica) yet the second is still a HIT.

**What happened under the hood.**

1. First `GET /events/{id}`: Catalog asks Redis for `catalog:event:{id}`, gets nothing, sets `X-Cache: MISS`, reads Postgres, writes the DTO to Redis with TTL = `Cache__TtlSeconds` randomised by plus or minus 10 % (so keys cached together do not expire together) ([EventCache.cs](../../src/Catalog.Api/Common/EventCache.cs), [GetEvent.cs](../../src/Catalog.Api/Features/GetEvent/GetEvent.cs)).
2. Second GET: key exists, `X-Cache: HIT`, no Postgres query. It does not matter which replica answers because the cache is in Redis, not in process memory.
3. The list key embeds a version: `catalog:v{version}:events:{search}`. `catalog:version` does not exist until the first write, so it reads as 0.
4. Admin `PUT`: Catalog first calls Inventory to change capacity, then saves to Postgres, then `DEL catalog:event:{id}` and `INCR catalog:version` ([UpdateEvent.cs](../../src/Catalog.Api/Features/UpdateEvent/UpdateEvent.cs)).
5. The next list request builds a key with the new version, so every cached search result becomes unreachable at once without scanning or deleting them; they simply expire.
6. Cache-key note: the list cache is shared by all searches, which is why invalidation is a counter bump rather than deleting patterns.

---

## 3. Redis down: graceful degradation

**Goal.** Show that the cache is optional: reads fall back to Postgres, and the system stays up. Guides: [03-caching.md](03-caching.md), [09-resilience-patterns.md](09-resilience-patterns.md).

**Setup.** Default stack and a cached event.

**Steps.**

```bash
EID=$(new_event "Lab 3" 10)
curl -si $BASE/events/$EID | grep -i x-cache          # MISS
curl -si $BASE/events/$EID | grep -i x-cache          # HIT

docker compose stop redis

for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -D - $BASE/events/$EID | grep -i -E 'x-cache|^[0-9]{3} '; done
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/events"                         # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/admin/events \
  -H 'X-Api-Key: dev-admin-key' -H 'Content-Type: application/json' \
  -d "{\"name\":\"Lab 3 b\",\"venue\":\"x\",\"startsAt\":\"$(future)\",\"totalTickets\":5,\"price\":10}"   # 201
docker compose logs --tail=20 catalog-api | grep -i redis
docker compose ps catalog-api                          # still healthy

docker compose start redis
sleep 3
curl -si $BASE/events/$EID | grep -i x-cache          # MISS then HIT again
```

**Expected result.** Every request returns `200` (or `201` for the create) with `X-Cache: MISS`; Catalog logs warnings such as "Redis unavailable, reading Postgres". Latency is higher than normal but bounded: the Redis client is configured with 1 s connect/command timeouts and a fail-fast backlog. `docker compose ps` still shows Catalog healthy because Redis is reported as `Degraded`, not `Unhealthy`. After `start redis`, caching resumes by itself (the multiplexer reconnects; allow a few seconds). **(unverified)** exact latency while Redis is down.

**What happened under the hood.**

1. At startup Catalog builds the Redis connection with `AbortOnConnectFail = false`, `BacklogPolicy.FailFast` and 1 s timeouts ([Program.cs](../../src/Catalog.Api/Program.cs)), so it can start without Redis and does not queue commands while it is down.
2. Every `EventCache` method wraps Redis in try/catch, logs a warning and returns "no value" ([EventCache.cs](../../src/Catalog.Api/Common/EventCache.cs)). A read failure is treated as a miss, so the handler reads Postgres and sets `X-Cache: MISS`.
3. The write-back after the DB read also fails and is swallowed.
4. Admin writes still succeed; `Invalidate` logs "cache not invalidated" and moves on.
5. `/health` runs a Postgres check (required) and a Redis check (returns `Degraded`), so Compose does not restart or take Catalog out of rotation ([HealthChecks.cs](../../src/Catalog.Api/Common/HealthChecks.cs)).
6. Hazard worth discussing: if you update an event while Redis is down, the invalidation is lost. If the old value is still in Redis when it comes back (Redis may reload its snapshot on restart; **unverified**), readers can see stale data until the TTL expires. The TTL is the safety net; that is why every key has one.

---

## 4. Load balancing across the 2 Catalog replicas (X-Upstream) and rate limiting (429)

**Goal.** See round-robin over replicas, and the gateway's per-client rate limit. Guide: [02-api-gateway-and-load-balancer.md](02-api-gateway-and-load-balancer.md).

**Setup.** Default stack (`catalog-api` has `deploy: { replicas: 2 }`).

**Steps.**

```bash
EID=$(new_event "Lab 4" 10)
docker compose ps catalog-api                          # two containers

for i in $(seq 1 10); do curl -s -o /dev/null -D - $BASE/events/$EID | tr -d '\r' | awk -F': ' 'tolower($1)=="x-upstream"{print $2}'; done | sort | uniq -c
```

Expected: two different `ip:8080` values, about five each.

Rate limit: the gateway allows 50 requests per second per client with a burst of 100; beyond that it answers `429`. Fire a burst from one machine:

```bash
seq 1 400 | xargs -P 100 -I{} curl -s -o /dev/null -w '%{http_code}\n' $BASE/events | sort | uniq -c
```

Expected: mostly `200` plus some `429` (the exact split depends on how fast your machine sends; if you see no 429, raise `-P` and the count). **(unverified)** the numbers.

Optional extras (not verified): `docker stop` one replica container (name from `docker compose ps catalog-api`) and repeat the `X-Upstream` loop; the upstream is DNS-resolved every 5 s so for a short time you may see errors, then all traffic goes to the survivor. `docker compose up -d --no-deps --no-build --scale catalog-api=3 catalog-api` adds a third one that should appear after DNS refresh.

Also check the hidden internal route:

```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/inventory/events/$EID   # 404 from the gateway
```

**What happened under the hood.**

1. nginx defines `upstream catalog { zone catalog 64k; server catalog-api:8080 resolve; }` and Docker's embedded DNS (`resolver 127.0.0.11 valid=5s`) returns one A record per replica. `resolve` plus `zone` makes nginx follow DNS and round-robin across all addresses ([nginx.conf](../../infra/nginx/nginx.conf)).
2. `add_header X-Upstream $upstream_addr always` echoes the address that served each request.
3. `limit_req_zone $binary_remote_addr zone=api:10m rate=50r/s` keys on client IP; every `location` uses `limit_req zone=api burst=100 nodelay` and `limit_req_status 429`. Up to 100 requests over the rate are admitted at once; further ones are rejected with 429.
4. From the host, all your requests share one source address on the Docker bridge, so they count against one bucket.
5. `/inventory` is `return 404;`: internal routes are not exposed ([contracts.md › Routing](../project/contracts.md#routing)).

---

## 5. The last-ticket race (two concurrent orders)

**Goal.** Prove two customers cannot buy the last ticket. Guide: [08-concurrency-and-inventory.md](08-concurrency-and-inventory.md).

**Setup.** Default stack. For a clean read of final state set `Payment__FailureRate: "0"` on the worker (otherwise a 10 % decline on the winner would release the ticket afterwards).

**Steps.**

```bash
EID=$(new_event "Lab 5 last ticket" 1)
avail $EID                                  # 1

curl -s -o /tmp/ra -w 'A %{http_code}\n' -X POST $BASE/orders -H 'Idempotency-Key: race-a' \
  -H 'Content-Type: application/json' -d "{\"eventId\":\"$EID\",\"quantity\":1,\"customerEmail\":\"a@example.com\"}" &
curl -s -o /tmp/rb -w 'B %{http_code}\n' -X POST $BASE/orders -H 'Idempotency-Key: race-b' \
  -H 'Content-Type: application/json' -d "{\"eventId\":\"$EID\",\"quantity\":1,\"customerEmail\":\"b@example.com\"}" &
wait

jq -c . /tmp/ra /tmp/rb
sleep 3
avail $EID                                  # 0
sql_orders "select idempotency_key,status,cancel_reason from orders where idempotency_key like 'race-%'"
sql_inv    "select * from stock where event_id='$EID'"
sql_inv    "select order_id,quantity,status from reservations where event_id='$EID'"
```

**Expected result.** Exactly one `202` and one `409` with `type: sold_out`. The loser's order row is `cancelled` / `sold_out`; there is exactly one active reservation and `available = 0` (never negative; the table also has `CHECK (0 <= available <= total_tickets)`).

**What happened under the hood.**

1. Both requests reach Order, which inserts two different `pending` orders (different keys).
2. Both call Inventory reserve concurrently. Each runs a transaction: `INSERT reservations ... ON CONFLICT DO NOTHING`, then `UPDATE stock SET available = available - @qty WHERE event_id = @id AND available >= @qty` ([ReserveStock.cs](../../src/Inventory.Api/Features/ReserveStock/ReserveStock.cs)).
3. Postgres takes a row lock on the `stock` row for the first `UPDATE`. The second one waits, then re-evaluates `available >= 1` against the committed value 0, matches 0 rows, and the handler rolls back (removing its reservation row) and returns `409 sold_out`.
4. Order maps 409 to `ReserveResult.SoldOut`, flips its order from `pending` to `cancelled`/`sold_out` (guarded by `AND status = 'pending'`) and returns `409`.
5. The check and the decrement are one atomic statement, not "read then write". That is the entire trick; an application-level `if (available > 0)` would oversell.

This scenario is also covered by required tests (see [tech-plan.md › Testing](../project/tech-plan.md#testing)) and is part of [smoke.sh](../../scripts/smoke.sh).

---

## 6. Client retry with the same Idempotency-Key

**Goal.** Safely repeat `POST /orders` (network timeout, double click) without creating a second order. Guide: [06-idempotency.md](06-idempotency.md).

**Steps.**

```bash
EID=$(new_event "Lab 6" 10)

place_order retry-1 $EID 2 | tail -1 | jq -c '{id,status}'      # 202, id X
place_order retry-1 $EID 2 | tail -1 | jq -c '{id,status}'      # 202, same id X
place_order retry-1 $EID 2 | tail -1 | jq -c '{id,status}'      # same id again

sleep 3
avail $EID                                                      # 8, not 4 or 6
sql_orders "select count(*) from orders where idempotency_key='retry-1'"                       # 1
sql_orders "select count(*) from outbox where type='OrderCreated' and payload->>'orderId'=(select id::text from orders where idempotency_key='retry-1')"   # 1

# a different payload with the same key is not compared: the original order wins
place_order retry-1 $EID 5 | tail -1 | jq -c '{id,quantity}'    # same id, quantity 2

# missing key is rejected
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/orders -H 'Content-Type: application/json' \
  -d "{\"eventId\":\"$EID\",\"quantity\":1,\"customerEmail\":\"a@b.com\"}"                      # 400
```

**Expected result.** All calls return the same order id; stock is reduced once, one order row and one `OrderCreated` outbox row exist. The reused key with a different quantity returns the original order (the code does not validate that the body matches; this is a deliberate simplification, so say so if you build on it).

**What happened under the hood.**

1. Order looks up `orders.idempotency_key` (unique index `ux_orders_idempotency_key`). Found and the order is no longer `pending`, or it is `pending` and `OrderCreated` is already in the outbox: return it as is, with 202 ([CreateOrder.cs](../../src/Order.Api/Features/CreateOrder/CreateOrder.cs)).
2. Concurrent first requests with the same key race on the unique index; the loser catches the unique violation and returns the winner's row.
3. A retry that finds a `pending` order without an outbox row (the first call died after saving the order, e.g. Inventory was unavailable) resumes at the reserve step. That is safe because Inventory reserve is itself idempotent by `orderId` (`ON CONFLICT DO NOTHING` returns `200` with the existing reservation).
4. Idempotency exists at three layers in this system: the API key, Inventory by `orderId`, and consumers (scenario 12).

Try the resume path after scenario 8: send a request while Inventory is failing (503), remove the toggle, resend the same key, and it completes.

---

## 7. Payment failure: saga compensation restores stock

**Goal.** A multi-service operation has no distributed transaction; failure is undone by a compensating action. Guide: [07-saga-and-compensation.md](07-saga-and-compensation.md).

**Setup.** Force every payment to fail:

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  worker:
    environment:
      Payment__FailureRate: "1"
EOF
docker compose up -d --no-deps --no-build --force-recreate worker
```

**Steps.**

```bash
EID=$(new_event "Lab 7" 5)
avail $EID                                       # 5
place_order saga-1 $EID 2 | tail -1 | jq -c '{id,status}'   # 202 pending
OID=<id>
avail $EID                                       # 3 for a moment (reserved)
sleep 4
order_json $OID                                  # {"status":"cancelled","cancelReason":"payment_failed","tickets":0}
avail $EID                                       # 5 again

sql_orders "select succeeded from payments where order_id='$OID'"                  # f
sql_orders "select type, published_at is not null as published from outbox where payload->>'orderId'='$OID'"
sql_inv    "select status, released_at is not null as released from reservations where order_id='$OID'"   # released
docker compose logs --tail=20 worker
```

In the RabbitMQ UI, `notification-queue` stays empty.

**Expected result.** Order ends `cancelled` / `payment_failed`, stock is back to 5, reservation `released`, no tickets, outbox has `OrderCreated` and `PaymentFailed`.

**What happened under the hood.**

1. Steps 1 to 6 of scenario 1: order `pending`, stock reserved, `OrderCreated` published to `payment-queue`.
2. `PaymentConsumer` draws `Random.NextDouble() >= FailureRate`; with rate 1 it always fails. In one transaction it sets the order `cancelled`/`payment_failed` (guarded by `status = 'pending'`), inserts `payments(succeeded=false)` and a `PaymentFailed` outbox row ([PaymentConsumer.cs](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs)).
3. After the commit, the consumer calls Inventory `DELETE /inventory/reservations/{orderId}` (retry up to 3 times, 2 s timeout) = the compensating action. Inventory marks the reservation `released` and adds the quantity back to `stock` ([ReleaseReservation.cs](../../src/Inventory.Api/Features/ReleaseReservation/ReleaseReservation.cs)).
4. If the release call fails, the handler throws, the message is not acked, and RabbitMQ redelivers; on redelivery the `payments` row exists, so payment is not re-drawn and only the (idempotent) release is retried.
5. `PaymentFailed` is published to the exchange but no queue is bound to it (observability only, [contracts.md › Messages](../project/contracts.md#messages)), so the broker drops it.
6. Order status never "rolls back": it moves forward to `cancelled`. That is the saga idea: compensate, don't undo.

Reset the override when done.

---

## 8. Inventory slow or erroring: timeout, retry, circuit breaker open, 503

**Goal.** Watch the HTTP resilience pipeline Order uses for reserve. Guide: [09-resilience-patterns.md](09-resilience-patterns.md).

**Setup.** Make Inventory reserve take 3 s (longer than Order's 2 s timeout). Create the event first; the toggles only affect reserve, not capacity updates or availability reads.

```bash
EID=$(new_event "Lab 8" 20)

cat > docker-compose.override.yml <<'EOF'
services:
  inventory-api:
    environment:
      Demo__DelayMs: "3000"
EOF
docker compose up -d --no-deps --no-build --force-recreate inventory-api
docker compose ps inventory-api     # wait until healthy
```

(For an erroring instead of slow Inventory use `Demo__ErrorRate: "1"`: reserve returns 500. The pipeline reacts the same way, just faster.)

**Steps.**

```bash
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "order $i: %{http_code} in %{time_total}s\n" -X POST $BASE/orders \
    -H "Idempotency-Key: cb-$i-$(date +%s)" -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"$EID\",\"quantity\":1,\"customerEmail\":\"lab@example.com\"}"
done
docker compose logs --tail=40 order-api | grep -i -E 'inventory|circuit'
sql_orders "select status,count(*) from orders where idempotency_key like 'cb-%' group by 1"
```

Expected: the first order takes about 6 to 7 s and returns `503` (three attempts of 2 s each plus 200 ms and 400 ms of backoff). The second also fails, and during it the breaker opens. Orders 3 and 4 return `503` almost instantly (milliseconds). The body is Problem Details with `type: dependency_unavailable`. The orders stay `pending` (see the SQL).

Wait 15 s: the breaker goes half-open and lets one trial call through. With the delay still on, it fails and the breaker re-opens; repeat the loop to see it.

Recover:

```bash
rm -f docker-compose.override.yml
docker compose up -d --no-deps --no-build --force-recreate inventory-api
sleep 15                                       # let the open breaker's 15 s break elapse
place_order cb-ok-1 $EID 1 | head -1          # 202
```

Then re-send one of the earlier keys (you need to copy it from `sql_orders "select idempotency_key from orders where status='pending'"`): it resumes at the reserve step (scenario 6) and succeeds. Pending orders that nobody retries are cancelled by the sweeper after `Orders__PendingTimeoutMinutes` (scenario 10).

**What happened under the hood.**

1. Order's `inventory-reserve` HttpClient has a resilience pipeline, outermost to innermost: retry (2 retries, 200 ms exponential), circuit breaker (failure ratio 0.5, minimum 5 calls in a 30 s window, break 15 s), per-attempt timeout 2 s ([Program.cs](../../src/Order.Api/Program.cs)).
2. Inventory sleeps `Demo__DelayMs` before touching the DB ([ReserveStock.cs](../../src/Inventory.Api/Features/ReserveStock/ReserveStock.cs)). Each attempt hits the 2 s timeout and surfaces as a timeout rejection, which the retry strategy handles.
3. Each attempt, including retried ones, counts as a sample for the breaker. After 5 failed samples out of 5 (end of the second request) the breaker opens.
4. While open, calls fail immediately with `BrokenCircuitException`, which the retry does not retry. `InventoryClient.Reserve` maps any dependency failure to `ReserveResult.Unavailable` ([InventoryClient.cs](../../src/Order.Api/Common/InventoryClient.cs)).
5. `CreateOrder` returns `503 dependency_unavailable` and leaves the order `pending`. The client can retry with the same key; otherwise the sweeper cleans up.
6. Why fail fast matters: without the breaker every request would hold a worker thread for about 6 s while Inventory is down, and the failure would spread to the gateway and clients.
7. Release calls (sweeper, Worker) use retry and timeout but no breaker.

---

## 9. Poison message: retries, then the dead-letter queue (notification errors)

**Goal.** A message that always fails must not loop forever. Guides: [04-message-broker.md](04-message-broker.md), [09-resilience-patterns.md](09-resilience-patterns.md).

**Setup.** Notification handler always throws, payment always succeeds:

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  worker:
    environment:
      Payment__FailureRate: "0"
      Demo__NotificationErrorRate: "1"
EOF
docker compose up -d --no-deps --no-build --force-recreate worker
```

**Steps.**

```bash
EID=$(new_event "Lab 9" 10)
place_order poison-1 $EID 1 | tail -1 | jq -c '{id,status}'
OID=<id>

docker compose logs -f worker | grep -i -E 'requeueing|Simulated'      # five warnings, then silence (Ctrl-C)
order_json $OID                                  # paid, tickets 0
curl -s -u guest:guest http://localhost:15672/api/queues/%2F/notification-dlq | jq '{messages}'   # 1
curl -s -u guest:guest http://localhost:15672/api/queues/%2F/notification-queue | jq '{messages}' # 0
```

In the UI: Queues, `notification-dlq`, "Get messages" (Ack mode: Nack message requeue true) to inspect the dead-lettered body (the `PaymentSucceeded` JSON). The queue's arguments show `x-delivery-limit` = 4 and `x-dead-letter-routing-key = notification-dlq`.

**Expected result.** The order is `paid` (payment is committed before notification runs) but has no tickets. The handler fails 5 times, then the broker moves the message to `notification-dlq`. The main queue is empty. Redelivery is immediate (consumer polls with about 250 ms idle gaps), so all of this takes a few seconds.

**What happened under the hood.**

1. `PaymentSucceeded` is published to `notification-queue`, a quorum queue with `x-delivery-limit`, `x-dead-letter-exchange = ""` (the default exchange) and `x-dead-letter-routing-key = notification-dlq` ([RabbitMq.cs](../../src/SuperTickets.Shared/Messaging/RabbitMq.cs)).
2. `NotificationConsumer` draws against `Demo__NotificationErrorRate` and throws "Simulated notification error" ([NotificationConsumer.cs](../../src/Worker/Features/SendNotification/NotificationConsumer.cs)).
3. `QueueConsumer` catches it, logs "Handling ... failed; requeueing it", and nacks with `requeue: true` ([QueueConsumer.cs](../../src/SuperTickets.Shared/Messaging/QueueConsumer.cs)). It stops the current poll batch at the first failure.
4. Each requeue increments the delivery count. `MaxDeliveries = 5` is configured as `x-delivery-limit = 4` (limit counts returns, so total deliveries = 5). When the limit is exceeded RabbitMQ dead-letters the message to `notification-dlq`.
5. The DLQ is just a durable queue; nothing consumes it. An operator inspects it and decides.
6. Recovery drill: remove the override and recreate the worker, then make the outbox republish the event (this is scenario 12 in disguise):

```bash
rm -f docker-compose.override.yml && docker compose up -d --no-deps --no-build --force-recreate worker
sql_orders "update outbox set published_at = null where type='PaymentSucceeded' and payload->>'orderId'='$OID'"
sleep 4; order_json $OID                        # tickets 1
```

The DLQ copy remains until you purge it in the UI.

---

## 10. Worker crash or lost message: the pending order expires via the sweeper

**Goal.** If an async step never happens, the order must not stay `pending` forever and stock must not stay locked. Guides: [07-saga-and-compensation.md](07-saga-and-compensation.md), [09-resilience-patterns.md](09-resilience-patterns.md).

**Setup.** Shorten expiry so you do not wait 5 minutes (minimum is 1: the setting is an integer number of minutes). Sweep every 5 s:

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  order-api:
    environment:
      Orders__PendingTimeoutMinutes: "1"
      Orders__SweepIntervalSeconds: "5"
EOF
docker compose up -d --no-deps --no-build --force-recreate order-api
```

**Steps.** Variant A, the worker is down:

```bash
docker compose stop worker
EID=$(new_event "Lab 10" 5)
place_order crash-1 $EID 2 | tail -1 | jq -c '{id,status}'
OID=<id>
avail $EID                                           # 3 (reserved)
curl -s -u guest:guest http://localhost:15672/api/queues/%2F/payment-queue | jq '{messages}'   # 1, waiting

sleep 75
order_json $OID                                      # {"status":"cancelled","cancelReason":"expired"}
avail $EID                                           # 5
sql_inv "select status from reservations where order_id='$OID'"   # released

docker compose start worker
sleep 5
docker compose logs --tail=10 worker | grep -i 'not pending'      # "payment skipped"
order_json $OID                                      # still cancelled/expired
curl -s -u guest:guest http://localhost:15672/api/queues/%2F/payment-queue | jq '{messages}'   # 0
```

Variant B, a truly lost message: instead of stopping the worker, open the RabbitMQ UI right after placing the order, go to `payment-queue`, and click "Purge Messages" (do it quickly, the worker normally consumes in under a second; stop the worker first to be safe). The order then follows the same expiry path. In the real world the loss would come from a broker disaster or a bug; the point is that expiry does not care why.

**Expected result.** After about 1 minute plus up to 5 s the order is `cancelled` with `cancelReason: expired`, availability is back, the reservation is `released`. When the Worker returns it consumes the stale `OrderCreated`, finds the order no longer `pending`, and does nothing (no ticket, no flipped status).

**What happened under the hood.**

1. The order is committed `pending`, the stock reserved, and `OrderCreated` published. Nothing consumes it (worker stopped) so it waits in the durable quorum queue.
2. The `Sweeper` hosted service in Order.Api wakes every `Orders__SweepIntervalSeconds`, selects `pending` orders older than `Orders__PendingTimeoutMinutes`, calls Inventory release for each, and only if the release succeeded runs `UPDATE orders SET status='cancelled', cancel_reason='expired' WHERE id=@id AND status='pending'` ([Sweeper.cs](../../src/Order.Api/Features/ExpirePending/Sweeper.cs)). A failed release leaves the order for the next pass.
3. Release before cancel is deliberate ordering: a crash in between leaves a `pending` order with already-released stock, and the next pass repeats the idempotent release. The reverse order could leak stock forever.
4. When the Worker later processes the stale message, `PayAsync` runs `UPDATE ... WHERE status = 'pending'`, touches 0 rows and returns null; the handler logs "is not pending; payment skipped" and acks ([PaymentConsumer.cs](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs)). Business rule: [business-plan.md › Orders and payment](../project/business-plan.md#orders-and-payment) rule 3.
5. That `AND status = 'pending'` guard is what lets the sweeper and the worker race without corrupting state.

---

## 11. Outbox: stop RabbitMQ, create an order, restart, the event is still delivered

**Goal.** The order and its event are saved atomically, and the broker is allowed to be down. Guide: [05-transactional-outbox.md](05-transactional-outbox.md).

**Setup.** Default stack; make payment deterministic if you want to see `paid` (override worker `Payment__FailureRate: "0"`). Use `stop`/`start`, not `down`, so the container keeps its queues. Do this within 5 minutes or the sweeper will expire the order (or raise `Orders__PendingTimeoutMinutes`).

**Steps.**

```bash
EID=$(new_event "Lab 11" 5)
docker compose stop rabbitmq

place_order outbox-1 $EID 1 | tail -1 | jq -c '{id,status}'      # still 202 pending
OID=<id>
sql_orders "select type, published_at from outbox where payload->>'orderId'='$OID'"   # OrderCreated, published_at empty
docker compose logs --tail=10 order-api | grep -i -E 'outbox|rabbit'                # publisher warnings, retrying every ~1s
order_json $OID                                                    # still pending
avail $EID                                                         # 4 (stock reserved)

docker compose start rabbitmq
# wait for health, then:
sleep 20
sql_orders "select type, published_at is not null as published from outbox where payload->>'orderId'='$OID'"   # published
order_json $OID                                                    # paid, tickets 1
```

**Expected result.** Creating the order works while RabbitMQ is down (202). The `OrderCreated` row sits unpublished. After RabbitMQ is back, the publisher delivers it, and the flow continues to `paid` with tickets, with no client action. Timing depends on broker startup (10 to 30 s); the RabbitMQ client auto-recovers its connection. **(unverified)** that no restart of order-api or worker is needed; if the order does not progress in about a minute, check `docker compose logs order-api worker`.

**What happened under the hood.**

1. `CreateOrder` never talks to RabbitMQ. It writes `OrderCreated` into the `outbox` table, in the same Postgres transaction that confirms the order's state ([CreateOrder.cs](../../src/Order.Api/Features/CreateOrder/CreateOrder.cs)). There is no dual write: the DB commit either contains both order and event or neither.
2. The `OutboxPublisher` loop tries `SELECT ... WHERE published_at IS NULL ... FOR UPDATE SKIP LOCKED`, publishes with publisher confirms, and sets `published_at` in the same transaction ([OutboxPublisher.cs](../../src/SuperTickets.Shared/Messaging/OutboxPublisher.cs)).
3. With the broker down the publish or channel creation throws; the loop logs "Outbox publish failed; will retry" and polls again after one second. On a publish failure it breaks out of the batch and commits only the rows already sent.
4. When RabbitMQ is back (topology was declared durable, so queues and bindings survived), the next poll publishes the row; `published_at` is set; the Worker takes over as in scenario 1.
5. Delivery is at-least-once: if the publisher crashed after the broker accepted a message but before the DB commit, the row would be published again. That is why consumers must be idempotent (scenario 12). The `MessageId` property equals the outbox row id, so duplicates are identifiable.
6. The compare-and-contrast question to ask: what would break if `CreateOrder` published directly after the commit?

---

## 12. Duplicate message delivery is harmless (replay)

**Goal.** Redeliver messages that were already processed and show that nothing changes. Guides: [06-idempotency.md](06-idempotency.md), [04-message-broker.md](04-message-broker.md).

**Setup.** Complete one paid order with tickets (scenario 1, worker `Payment__FailureRate: "0"`). Order id in `$OID`, event in `$EID`.

**Steps.** Snapshot, replay, compare. Replaying means flipping `published_at` back to null so the outbox publisher re-sends the original rows with the same `MessageId`:

```bash
sql_orders "select count(*) as tickets from tickets where order_id='$OID'"      # 2
sql_orders "select count(*) as payments from payments where order_id='$OID'"    # 1
avail $EID

sql_orders "update outbox set published_at = null where payload->>'orderId'='$OID'"   # replays OrderCreated AND PaymentSucceeded
sleep 5
docker compose logs --tail=20 worker | grep -i -E 'not pending|Confirmation|payment'

sql_orders "select count(*) as tickets from tickets where order_id='$OID'"      # still 2
sql_orders "select count(*) as payments from payments where order_id='$OID'"    # still 1
order_json $OID                                                                  # still paid
avail $EID                                                                       # unchanged
sql_orders "select type, published_at is not null as published from outbox where payload->>'orderId'='$OID'"   # re-published
```

Repeat with a cancelled order from scenario 7 (replays `OrderCreated` and `PaymentFailed`): availability must not go above the event total (release only acts on `status = 'active'` reservations).

You can also publish by hand: RabbitMQ UI, Exchanges, `supertickets-events`, Publish message, routing key `PaymentSucceeded`, payload `{"orderId":"<OID>","eventId":"<EID>","quantity":2,"customerEmail":"lab@example.com","paidAt":"2026-01-01T00:00:00Z"}`. Expect the same "no new tickets".

**Expected result.** The Worker logs the replayed `PaymentSucceeded` as a normal confirmation ("Confirmation sent ...") because it is not aware it is a duplicate, but tickets are still 1 and 2, with no extra rows. The replayed `OrderCreated` is a no-op: the `payments` row already exists, so no new draw happens and no status changes. Availability and order status are unchanged.

**What happened under the hood.**

1. Replayed `OrderCreated` reaches `PaymentConsumer`. It finds the existing `payments` row, so it neither draws again nor updates the order; if `succeeded` were false it would call release again, which is a no-op for an already released reservation ([PaymentConsumer.cs](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs), [ReleaseReservation.cs](../../src/Inventory.Api/Features/ReleaseReservation/ReleaseReservation.cs)).
2. Replayed `PaymentSucceeded` reaches `NotificationConsumer`, which runs `INSERT ... SELECT generate_series(1, qty) ... ON CONFLICT (order_id, number) DO NOTHING` against the unique index `ux_tickets_order_number` ([Entities / OrderDbContext.cs](../../src/Order.Data/OrderDbContext.cs)). Zero rows are inserted.
3. Every state change in the chain is either unique-keyed (`payments.order_id`, `tickets(order_id, number)`, `reservations.order_id`) or guarded (`WHERE status = 'pending'`, `status = 'active'`). Applying a message N times has the same effect as once.
4. Duplicates are expected, not exceptional: the outbox is at-least-once (scenario 11), requeue-on-failure redelivers (scenario 9), and clients retry (scenario 6). Required replay tests live in [tech-plan.md › Testing](../project/tech-plan.md#testing) and the `tests/` projects.

---

## Cleanup

```bash
rm -f docker-compose.override.yml
docker compose up -d --force-recreate      # back to defaults
# or wipe everything including data:
docker compose down -v
```

`scripts/smoke.sh` runs a compressed, automated version of scenarios 1, 2, 4, 5, 6, 7 and 9 (`--no-toggles` skips 7 and 9).

## Command accuracy notes

- Verified by reading the source: env keys and defaults, routes, headers, table and column names, queue and exchange names, resilience numbers (timeouts, retries, breaker, delivery limit), SQL semantics.
- Not run live in this session: any `docker compose` command, timing figures, log line text, the 429 counts in scenario 4, the Redis restart behaviour in scenario 3, and RabbitMQ auto-recovery in scenario 11. Treat those as expectations to confirm.
- `<id from the response body>` placeholders mean copy the `id` from the previous JSON output.
