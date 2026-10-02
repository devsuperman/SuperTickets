# Idempotency

**In one sentence:** an operation is idempotent when doing it twice has the same effect as doing it once, which is what lets clients and brokers retry freely without double-charging, double-reserving or double-ticketing.

## The problem

A customer taps "Buy" for the last 2 tickets. The request reaches Order, stock is reserved, but the response is lost on a flaky connection. The browser retries. Without protection the second request creates a second order and reserves 2 more tickets: the customer holds 4 and pays twice. The same story happens inside the system: RabbitMQ is at-least-once, so the payment worker can receive `OrderCreated` twice (for example it crashed after processing but before the ack), and a naive handler would charge twice and send two sets of tickets.

## The concept

Networks give you three choices for a call: at-most-once (never retry, may lose work), at-least-once (retry until acknowledged, may duplicate), or exactly-once (not achievable end to end). Practical systems pick at-least-once delivery and make the receiver idempotent, so the *effect* is exactly-once.

Two common techniques:

- **Natural key / unique constraint:** use an id the caller already owns (here `orderId`) and let the database reject or ignore the second write.
- **Guarded state transition:** apply a change only if the row is still in the expected state (`WHERE status = 'pending'`); a replay finds 0 rows and does nothing.

Two kinds of repetition, handled differently:

| | Client retry | Message redelivery |
|---|---|---|
| Source | Browser/user/proxy resends the HTTP request | Broker redelivers after nack, timeout or crash |
| Identity | Caller-supplied `Idempotency-Key` header | `orderId` inside the message |
| Answer to a duplicate | Return the original result | Silently do nothing more |

## How SuperTickets applies it

Every idempotent spot, in the order a purchase meets them (contract: [contracts.md](../project/contracts.md), plan: [tech-plan.md › Resilience patterns](../project/tech-plan.md)).

1. **`Idempotency-Key` on `POST /orders`.** [CreateOrder.Handle](../../src/Order.Api/Features/CreateOrder/CreateOrder.cs) looks up the order by key. If new, it inserts a `pending` row; two concurrent first requests collide on the unique index `ux_orders_idempotency_key` ([OrderDbContext](../../src/Order.Data/OrderDbContext.cs)), the loser catches the `UniqueViolation` and returns the winner. If the order is already final, or `pending` with an `OrderCreated` outbox row (`HasOrderCreated`), it is returned as-is (202). A `pending` order without that row is *resumed* at the reserve step, which is what makes a retry after a 503 work.
2. **Reserve by `orderId`.** [ReserveStock](../../src/Inventory.Api/Features/ReserveStock/ReserveStock.cs) does `INSERT INTO reservations ... ON CONFLICT (order_id) DO NOTHING`. Zero rows inserted means replay: it returns the existing reservation (200 instead of 201) and does *not* decrement stock again.
3. **Release by `orderId`.** [ReleaseReservation](../../src/Inventory.Api/Features/ReleaseReservation/ReleaseReservation.cs) flips `active` to `released` and adds stock back in one CTE; the `WHERE status = 'active'` means a second release matches nothing and returns 204 anyway.
4. **One `payments` row per order.** [PaymentConsumer.HandleAsync](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs) first looks for an existing `payments` row (primary key `order_id`). If present, it reuses the recorded outcome instead of rolling `Payment__FailureRate` again; a failed outcome simply re-runs the (idempotent) release. This is how a crash between "payment recorded" and "stock released" heals on redelivery.
5. **Guarded status update.** Inside `PayAsync` the order update is `WHERE id = ... AND status = 'pending'`; 0 rows means the sweeper or another delivery already decided, so the payment is skipped.
6. **Tickets `unique (order_id, number)`.** [NotificationConsumer](../../src/Worker/Features/SendNotification/NotificationConsumer.cs) inserts tickets `1..quantity` with `ON CONFLICT (order_id, number) DO NOTHING` (index `ux_tickets_order_number`), so a duplicate `PaymentSucceeded` creates nothing new.
7. **Retries are safe because of all this.** The Inventory HTTP clients retry on timeout ([InventoryClient](../../src/Order.Api/Common/InventoryClient.cs)); see [09-resilience-patterns.md](09-resilience-patterns.md).

Tests that replay each operation: `Same_key_gives_one_order_and_one_outbox_row` ([OrderTests](../../tests/Order.Api.Tests/OrderTests.cs)), `Reserve_replay_is_a_noop` and `Release_restores_stock_and_replay_is_a_noop` ([InventoryTests](../../tests/Inventory.Api.Tests/InventoryTests.cs)), `Duplicate_OrderCreated_gives_one_payment_and_one_event` and `Duplicate_PaymentSucceeded_creates_quantity_tickets` ([WorkerTests](../../tests/Worker.Tests/WorkerTests.cs)).

## Try it

```bash
docker compose up --build -d --wait
EV=$(curl -s -X POST localhost:8080/admin/events -H 'X-Api-Key: dev-admin-key' -H 'Content-Type: application/json' \
  -d '{"name":"Idem","venue":"Hall","startsAt":"2030-01-01T20:00:00Z","totalTickets":10,"price":10}' | jq -r .id)

# Same key three times: same order id every time
for i in 1 2 3; do
  curl -s -X POST localhost:8080/orders -H 'Idempotency-Key: demo-1' -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"$EV\",\"quantity\":2,\"customerEmail\":\"a@b.com\"}" | jq -c '{id,status}'
done
curl -s localhost:8080/events/$EV/availability   # 8, not 4
```

Inspect the evidence:

```bash
docker compose exec postgres psql -U postgres -d orders -c "select count(*) from orders where idempotency_key='demo-1'"
docker compose exec postgres psql -U postgres -d orders -c "select order_id, count(*) from tickets group by 1"
docker compose exec postgres psql -U postgres -d inventory -c "select * from reservations"
```

Force redelivery: set `Demo__NotificationErrorRate=0.5` on the worker (see [contracts.md › Configuration](../project/contracts.md#configuration)), buy a few orders, and verify each paid order still ends with exactly `quantity` tickets. A different key with the same body creates a *new* order: the key, not the body, is the identity.

## Trade-offs and what we did NOT do

- The key is not bound to the request body: reusing a key with a different payload returns the original order rather than a 422/409. Stripe-style fingerprinting was left out to stay minimal.
- Keys never expire (they live as long as the `orders` row). A production system would purge or scope them.
- No inbox/dedup table for messages. Idempotency comes from each handler's own natural keys and guards, which is simpler but must be re-thought for every new handler.
- `HasOrderCreated` scans the outbox JSON payload; fine for a demo, an indexed column would be needed at scale.

## Check yourself

1. Why does a replayed reserve return 200 and not decrement stock again?
2. Two identical `POST /orders` hit Order at the same instant. What stops two orders being created?
3. Why does the payment handler read `payments` before rolling the failure rate?
4. A client retry and a message redelivery are both "duplicates". Which one needs the `Idempotency-Key`?

<details><summary>Answers</summary>

1. `INSERT ... ON CONFLICT (order_id) DO NOTHING` inserts 0 rows, so the handler returns the existing reservation before reaching the `UPDATE stock`.
2. The unique index on `idempotency_key`; the loser catches the unique violation and returns the winner's order.
3. So a redelivery reuses the first outcome; otherwise a failed payment could flip to success (or the reverse) on the second delivery.
4. Only the client retry. Messages already carry `orderId`, which each handler uses as its natural key.
</details>

## Further reading

- Stripe API "Idempotent requests" and the IETF `Idempotency-Key` HTTP header draft.
- "At-least-once delivery" and "exactly-once is a lie" (Kleppmann, *Designing Data-Intensive Applications*, ch. 11).
- Next: [07-saga-and-compensation.md](07-saga-and-compensation.md); previous: [05-transactional-outbox.md](05-transactional-outbox.md); contracts in [contracts.md](../project/contracts.md).
