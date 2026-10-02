# Transactional outbox

**In one sentence:** instead of updating the database and publishing to the broker as two separate steps (which can half-fail), you write the event into an `outbox` table in the same database transaction as the state change, and a background publisher later delivers those rows to the broker, so a change and its event either both happen or neither does.

Previous: [04-message-broker.md](04-message-broker.md) · Next: [06-idempotency.md](06-idempotency.md)

## The problem

The naive order flow is: `INSERT order` then `publish OrderCreated`. Two things can go wrong:

- DB commit succeeds, the process crashes (or RabbitMQ is unreachable) before the publish: the order exists, nobody ever charges it. It sits `pending` forever.
- Publish first, then DB commit fails: a payment is processed for an order that does not exist.

This is the **dual-write problem**: two systems (Postgres, RabbitMQ) cannot share one atomic transaction, so any ordering of two writes leaves a failure window.

## The concept

Make it one write to one system, and move the second hop to retryable background work.

```
 request tx (atomic)                     background
+----------------------------+          +------------------------------+
| UPDATE/INSERT business row |          | SELECT ... WHERE published_at |
| INSERT outbox(event)       |  ----->  |   IS NULL FOR UPDATE SKIP LOCKED
+----------------------------+          | publish to broker             |
                                        | SET published_at = now()      |
                                        +------------------------------+
```

- The **outbox table** is a durable to-do list of events to send.
- The **publisher** polls it, publishes, then marks rows as published.
- `FOR UPDATE SKIP LOCKED` lets several publishers run concurrently: each locks a batch, and others skip locked rows instead of waiting or double-sending.
- A crash after publish but before the mark means the row is published again: **at-least-once**, so consumers must be idempotent ([06-idempotency.md](06-idempotency.md)).

## How SuperTickets applies it

Table (`outbox(id, type, payload jsonb, correlation_id, created_at, published_at)` with a partial index on unpublished rows) is mapped by [`OutboxExtensions.AddOutbox`](../../src/SuperTickets.Shared/Messaging/Outbox.cs) from `OnModelCreating`; the row type is `OutboxMessage`. Schema: [contracts.md > Databases](../project/contracts.md#databases).

**Writing an event.** `OutboxExtensions.AddToOutbox<TMessage>(this DbContext db, ...)` only adds a row to the change tracker, with the ambient correlation ID. Nothing is sent until the caller's `SaveChanges`/commit, so the event commits atomically with the state change.

**Order.Api.** In [`CreateOrder.Handle`](../../src/Order.Api/Features/CreateOrder/CreateOrder.cs), after Inventory confirms the reservation, one transaction does `UPDATE orders ... WHERE status = 'pending'`, checks `HasOrderCreated`, then `db.AddToOutbox(new OrderCreated(...))` and commits. The `HasOrderCreated` check makes a same-key retry not insert a second event (see [06](06-idempotency.md)). Response is `202`: the order is accepted, payment happens later.

**Worker.** [`PaymentConsumer.PayAsync`](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs) updates the order, inserts the `payments` row and calls `AddToOutbox(PaymentSucceeded | PaymentFailed)` in one transaction. The Worker has **no publisher of its own**.

**Publisher.** [`OutboxPublisher<TDbContext>`](../../src/SuperTickets.Shared/Messaging/OutboxPublisher.cs) is registered once, in [`Order.Api/Program.cs`](../../src/Order.Api/Program.cs) as `AddHostedService<OutboxPublisher<OrderDbContext>>()`. Worker and Order share the `orders` database ([`Order.Data`](../../src/Order.Data)), so the rows Worker writes are published by Order.Api too ([contracts.md > Flows](../project/contracts.md#flows)).

`PublishPendingAsync` per batch:

1. `EnsureTopologyAsync`, open a channel with publisher confirms.
2. Begin a transaction and run `SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED` (`BatchSize = 50`).
3. For each row, `BasicPublishAsync` to the exchange with routing key = `row.Type`, persistent, `MessageId` = row id, `CorrelationId`, header `eventType`.
4. On a publish error, `break` (keep order, commit what was sent), set `PublishedAt` for sent rows, `SaveChanges`, commit.

The loop polls every `PollInterval` (1 s) and loops immediately while batches are full. Broker unreachable? The exception is logged and retried next tick; rows stay unpublished.

## Try it

```bash
docker compose up --build -d --wait
EVENT_ID=$(curl -s http://localhost:8080/events | jq -r '.[0].id')

# 1. Stop the broker, then place an order: it still returns 202
docker compose stop rabbitmq
curl -s -X POST http://localhost:8080/orders -H "Idempotency-Key: outbox-$RANDOM" \
  -H 'Content-Type: application/json' \
  -d "{\"eventId\":\"$EVENT_ID\",\"quantity\":1,\"customerEmail\":\"a@b.com\"}"

# 2. The event is waiting in the table
docker compose exec postgres psql -U postgres -d orders \
  -c "SELECT type, created_at, published_at FROM outbox ORDER BY created_at DESC LIMIT 5;"

# 3. Bring the broker back; within a second or two published_at is filled and the order moves on
docker compose start rabbitmq
docker compose logs -f order-api worker
curl -s http://localhost:8080/orders/<order-id>

# Watch the Worker's rows: PaymentSucceeded/PaymentFailed also appear here and are published by order-api
```

The RabbitMQ UI is at http://localhost:15672 (guest/guest). Toggles from [contracts.md > Configuration](../project/contracts.md#configuration): `Payment__FailureRate=1` makes every payment produce a `PaymentFailed` row; `Demo__NotificationErrorRate=1` makes redelivered messages reach the DLQ ([04](04-message-broker.md)). Tests: [tests/SuperTickets.Shared.Tests/MessagingTests.cs](../../tests/SuperTickets.Shared.Tests/MessagingTests.cs).

## Trade-offs and what we did NOT do

- **Latency.** Up to about 1 s polling delay between commit and publish.
- **Duplicates by design.** A crash between publish and commit republishes. The shared `MessageId` (the row id) allows deduping, but we rely on idempotent handlers instead.
- **Published rows are never deleted.** Rows accumulate; a real system needs a cleanup job.
- **Single point of publishing.** Order.Api owns the publisher for both services; if it is down, Worker events wait too. It keeps one publisher implementation, and `SKIP LOCKED` would allow more replicas.
- **Strict ordering is best effort.** Batches are `ORDER BY created_at`, but concurrent publishers and redelivery can reorder.
- **Not adopted:** Debezium/CDC tailing the WAL, Postgres `LISTEN/NOTIFY`, an inbox table for consumers. Polling is the smallest thing that works ([business-plan.md](../project/business-plan.md), [tech-plan.md > Resilience](../project/tech-plan.md#resilience-patterns)).

## Check yourself

1. Which two failure windows does the outbox close, and which new one does it introduce?
2. Why is `FOR UPDATE SKIP LOCKED` used instead of plain `FOR UPDATE`?
3. Worker never publishes to RabbitMQ. How does `PaymentSucceeded` reach the broker?
4. If the broker is down for an hour, what happens to new orders?

<details>
<summary>Answers</summary>

1. It closes "state saved but event lost" and "event sent but state not saved". It introduces "event sent twice" (crash after publish, before `published_at`), so consumers must be idempotent.
2. Concurrent publishers each take different rows without blocking or double-publishing; plain `FOR UPDATE` would make them wait on each other.
3. `PaymentConsumer` writes it into the shared `orders` DB outbox in the same transaction as the payment; Order.Api's `OutboxPublisher<OrderDbContext>` publishes it.
4. Orders are still accepted (`202`); rows pile up with `published_at IS NULL`. When RabbitMQ returns they are published in `created_at` order. (The pending-order sweeper may cancel orders older than `Orders__PendingTimeoutMinutes`, see [07](07-saga-and-compensation.md).)
</details>

## Further reading

- Chris Richardson, "Transactional outbox" (microservices.io patterns)
- PostgreSQL docs: `SELECT ... FOR UPDATE SKIP LOCKED`
- Change Data Capture and Debezium (the heavier alternative to polling)
