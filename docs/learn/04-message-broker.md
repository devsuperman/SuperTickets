# Message broker: RabbitMQ

**In one sentence:** a message broker sits between a service that has something to say (a producer) and services that react to it (consumers), storing messages durably so work happens asynchronously, survives crashes, and can be retried; SuperTickets uses RabbitMQ with one topic exchange, one quorum queue per consumer, manual acks and a dead-letter queue per queue.

Previous: [03-caching.md](03-caching.md) · Next: [05-transactional-outbox.md](05-transactional-outbox.md)

## The problem

`POST /orders` used to do everything inline: reserve stock, charge the card, create tickets, send the email. The payment provider has a slow minute, so every checkout request hangs for 30 s and the web tier runs out of threads. Then the email service throws, the handler crashes after charging the card, and the customer sees an error for an order that was paid. Doing everything synchronously couples the caller's latency and availability to the slowest, flakiest step.

## The concept

**Sync vs async.** With a direct call, the caller waits and fails if the callee fails. With a broker, the caller hands off a message and moves on; the consumer processes it when it can.

```
producer --> [ exchange ] --routing key--> [ queue ] --> consumer
                 |                          (binding)
                 +--other key--> [ other queue ] --> other consumer
```

- **Exchange**: receives published messages and routes them. A **topic** exchange matches the message's **routing key** against queue **bindings**.
- **Queue**: durable buffer; each message goes to one consumer of that queue.
- **Binding**: the rule "queue Q receives routing key K".
- **Quorum queue**: a replicated, Raft-based durable queue type (safer than classic mirrored queues, and it supports `x-delivery-limit`).
- **Manual ack**: the broker keeps a message until the consumer says `ack`. If the consumer dies or `nack`s with requeue, it is redelivered.
- **Delivery limit + DLQ**: after N deliveries a message is *dead-lettered* to a dead-letter queue so a poison message cannot loop forever.
- **At-least-once delivery**: ack-after-processing means a crash between "done" and "ack" causes a redelivery. Consumers must be idempotent ([06-idempotency.md](06-idempotency.md)). "Exactly once" is not offered; you build it from at-least-once plus idempotency.

## How SuperTickets applies it

Topology is declared in [`RabbitMq.EnsureTopologyAsync`](../../src/SuperTickets.Shared/Messaging/RabbitMq.cs) and `DeclareConsumerQueueAsync`; declarations are idempotent, so every publisher and consumer calls them at start.

| Piece | Value |
|---|---|
| Exchange | `supertickets-events` (topic, durable) |
| `payment-queue` | bound with `OrderCreated`, DLQ `payment-dlq` |
| `notification-queue` | bound with `PaymentSucceeded`, DLQ `notification-dlq` |
| Message types | records in [`Contracts/Messages.cs`](../../src/SuperTickets.Shared/Messaging/Contracts/Messages.cs) |

Contract: [contracts.md > Messages](../project/contracts.md#messages). `PaymentFailed` is published but bound to no queue, so the broker drops it (observability only).

```
Order.Api --OrderCreated--> exchange --> payment-queue --> Worker PaymentConsumer
Worker    --PaymentSucceeded--> exchange --> notification-queue --> Worker NotificationConsumer
                                   (failed 5x) --> payment-dlq / notification-dlq
```

**Producer.** Services never publish directly; they write an outbox row and [`OutboxPublisher`](../../src/SuperTickets.Shared/Messaging/OutboxPublisher.cs) calls `BasicPublishAsync` with routing key = event type, `DeliveryMode = Persistent`, `MessageId`, `CorrelationId` and header `eventType`, on a channel with publisher confirms. Why: [05-transactional-outbox.md](05-transactional-outbox.md).

**Consumer.** [`QueueConsumer<TMessage>`](../../src/SuperTickets.Shared/Messaging/QueueConsumer.cs) is a `BackgroundService` that polls with `BasicGetAsync(autoAck: false)`, restores the correlation ID from the message, deserializes, calls `HandleAsync`, and only then `BasicAckAsync`. Any exception triggers `BasicNackAsync(requeue: true)`. It stops the batch on the first failure and sleeps `IdleDelay` (250 ms) when idle. Two subclasses: [`PaymentConsumer`](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs) and [`NotificationConsumer`](../../src/Worker/Features/SendNotification/NotificationConsumer.cs), registered in [`WorkerServices.AddWorker`](../../src/Worker/WorkerServices.cs).

**Delivery limit.** Main queues are declared with `x-queue-type=quorum`, `x-delivery-limit = MaxDeliveries - 1`, `x-dead-letter-exchange = ""` and `x-dead-letter-routing-key = <dlq>`. The default exchange routes by queue name, so a dead-lettered message lands in the DLQ. Config: `Messaging__MaxDeliveries` (default `5`), `Messaging__Exchange`, `__PaymentQueue`, `__NotificationQueue` ([contracts.md > Configuration](../project/contracts.md#configuration)). The DLQ name is derived by replacing `-queue` with `-dlq` (`MessagingOptions.DlqName`).

**At-least-once in practice.** Handlers are safe to repeat: `PaymentConsumer` reuses an existing `payments` row and updates the order only `WHERE status = 'pending'`; `NotificationConsumer` inserts tickets with `ON CONFLICT (order_id, number) DO NOTHING`.

## Try it

```bash
docker compose up --build -d --wait
# RabbitMQ UI: http://localhost:15672  (guest / guest) -> Exchanges, Queues, Bindings

# Place an order and watch it flow (replace EVENT_ID from GET /events)
EVENT_ID=$(curl -s http://localhost:8080/events | jq -r '.[0].id')
curl -s -X POST http://localhost:8080/orders -H "Idempotency-Key: demo-$RANDOM" \
  -H 'Content-Type: application/json' \
  -d "{\"eventId\":\"$EVENT_ID\",\"quantity\":1,\"customerEmail\":\"a@b.com\"}"
docker compose logs -f worker

# Make the notification handler fail: message is nacked, redelivered, then lands in notification-dlq
docker compose stop worker
docker compose run -d --no-deps -e Payment__FailureRate=0 -e Demo__NotificationErrorRate=1 worker
# (or set the env vars on the worker service in docker-compose.yml and `docker compose up -d worker`)
# Place a few orders, then in the UI open Queues > notification-dlq > Get messages.

# Broker down/up: stop and start it, producers and consumers reconnect
docker compose stop rabbitmq && docker compose start rabbitmq
```

`scripts/smoke.sh` automates both the payment-failure and DLQ scenarios (`--no-toggles` skips them). Tests: [tests/SuperTickets.Shared.Tests/MessagingTests.cs](../../tests/SuperTickets.Shared.Tests/MessagingTests.cs).

## Trade-offs and what we did NOT do

- **Polling, not push.** `BasicGetAsync` in a loop is simpler to reason about and test than `BasicConsume` event handlers, but adds up to ~250 ms latency and wastes calls when idle.
- **Immediate redelivery.** `nack` + `requeue` returns the message right away; there is no delayed retry exchange or exponential backoff. Five quick failures can burn the limit during a short outage.
- **No automatic DLQ reprocessing.** Messages in `*-dlq` wait for a human.
- **No ordering guarantee** across redeliveries; handlers must not assume it.
- **Not adopted:** multiple brokers/clusters, schema registry, per-message TTL, priority queues, `mandatory` publish returns. One exchange and two queues are enough to teach the ideas.
- Retries inside a handler (Inventory calls) use HTTP resilience, covered in [09-resilience-patterns.md](09-resilience-patterns.md); the saga built on these messages is in [07-saga-and-compensation.md](07-saga-and-compensation.md).

## Check yourself

1. Why does the consumer ack *after* `HandleAsync` and not before?
2. With `Messaging__MaxDeliveries=5`, what `x-delivery-limit` is declared and why?
3. Which queue receives `PaymentFailed`?
4. A worker crashes after inserting tickets but before the ack. What happens, and what makes it safe?

<details>
<summary>Answers</summary>

1. Acking first would lose the message if processing then failed. Ack-after gives at-least-once: failures leave the message on the queue.
2. `4`. The limit counts redeliveries (returns), so 1 first delivery + 4 returns = 5 deliveries in total before dead-lettering.
3. None. No queue is bound to that routing key, so the exchange discards it; it exists for observability.
4. The broker redelivers. `INSERT ... ON CONFLICT (order_id, number) DO NOTHING` makes the second run a no-op (idempotent consumer).
</details>

## Further reading

- RabbitMQ tutorials: work queues, topics; "Quorum Queues" and "Dead Letter Exchanges" guides
- "Enterprise Integration Patterns" (Hohpe and Woolf): Message Channel, Dead Letter Channel, Idempotent Receiver
- Delivery semantics: at-most-once, at-least-once, "exactly-once" myths
