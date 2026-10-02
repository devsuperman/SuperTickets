# Concurrency and inventory

**In one sentence:** when many buyers hit the same row at once, "check then update" in application code oversells, so the check and the decrement must be one atomic statement guarded by a database constraint.

## The problem

One ticket left. Customer A and B both call reserve at the same moment. Naive code does `SELECT available` (sees 1 for both), then `UPDATE available = available - 1` for both. Result: two buyers, one seat, `available = -1`, and an apology email. This is the classic lost-update / check-then-act race and the business rule it breaks is "two customers cannot buy the last ticket" ([business-plan.md](../project/business-plan.md)).

## The concept

- **Race condition:** correctness depends on timing between steps.
- **Atomic conditional update:** push the condition into the write: `UPDATE ... SET available = available - @qty WHERE available >= @qty`. Postgres takes a row lock for the update; a concurrent updater waits, then re-evaluates the `WHERE` against the new value. The statement reports rows affected: 1 = won, 0 = lost.
- **Constraint as safety net:** a `CHECK` makes the invalid state unrepresentable even if a future bug skips the guard.
- **Transaction:** groups the reservation row and the stock change so they commit or vanish together.
- **Pessimistic/optimistic alternatives:** `SELECT ... FOR UPDATE`, version columns, distributed locks (Redis/ZooKeeper). Each adds round trips, failure modes or both.

```
A: UPDATE ... WHERE available >= 1   -> locks row, available 1 -> 0, 1 row
B: UPDATE ... WHERE available >= 1   -> waits, re-checks 0 >= 1 false, 0 rows -> 409 sold_out
```

## How SuperTickets applies it

Inventory is the only writer of stock and uses plain SQL (no EF) on purpose: [ReserveStock.Handle](../../src/Inventory.Api/Features/ReserveStock/ReserveStock.cs).

1. Open a transaction.
2. `INSERT INTO reservations ... ON CONFLICT (order_id) DO NOTHING` (idempotency, see [06](06-idempotency.md)); the `WHERE EXISTS (SELECT 1 FROM stock ...)` distinguishes unknown events (404).
3. `UPDATE stock SET available = available - @qty WHERE event_id = @event AND available >= @qty`.
4. 0 rows updated: `RollbackAsync` (which also removes the reservation row from step 2) and return 409 `sold_out`. 1 row: commit, 201.

The schema in [Database.cs](../../src/Inventory.Api/Common/Database.cs) adds `CONSTRAINT stock_available_range CHECK (0 <= available AND available <= total_tickets)`, so even a buggy update cannot go negative or above capacity.

**Release** ([ReleaseReservation](../../src/Inventory.Api/Features/ReleaseReservation/ReleaseReservation.cs)) is one CTE: flip `active` to `released` and add `quantity` back, atomically, only once per order.

**Set capacity** ([SetCapacity](../../src/Inventory.Api/Features/SetCapacity/SetCapacity.cs)) is an upsert whose update branch is:

```sql
UPDATE stock SET available = available + (@new - total_tickets), total_tickets = @new
WHERE event_id = @id AND @new >= total_tickets - available
```

`total_tickets - available` is the number already reserved/sold, so you cannot cut capacity below it (409 `capacity_below_sold`); the delta adjusts `available` without touching reservations. It runs at the same row lock, so it is also safe against concurrent reserves. Catalog calls it before saving an event ([01-microservices-and-vertical-slice.md](01-microservices-and-vertical-slice.md)).

**The proof test:** `Twenty_parallel_reserves_for_one_ticket_yield_one_201` in [InventoryTests](../../tests/Inventory.Api.Tests/InventoryTests.cs) fires 20 concurrent reserves for a 1-ticket event against real Postgres (Testcontainers) and asserts exactly one 201, nineteen 409 with `type = sold_out`, and `available = 0`. The end-to-end version is step 5 of [scripts/smoke.sh](../../scripts/smoke.sh): two concurrent orders for the last ticket must return `202 409`. At the order level, a lost race becomes `cancelled`/`sold_out` ([CreateOrder](../../src/Order.Api/Features/CreateOrder/CreateOrder.cs)); see [07](07-saga-and-compensation.md).

"Sold" includes reserved-but-unpaid tickets (MVP decision in business-plan.md), which is why the sweeper matters.

## Try it

```bash
docker compose up --build -d --wait
EV=$(curl -s -X POST localhost:8080/admin/events -H 'X-Api-Key: dev-admin-key' -H 'Content-Type: application/json' \
  -d '{"name":"Last","venue":"Hall","startsAt":"2030-01-01T20:00:00Z","totalTickets":1,"price":10}' | jq -r .id)

for k in a b c d e; do
  curl -s -o /dev/null -w "$k %{http_code}\n" -X POST localhost:8080/orders -H "Idempotency-Key: race-$k" \
    -H 'Content-Type: application/json' -d "{\"eventId\":\"$EV\",\"quantity\":1,\"customerEmail\":\"a@b.com\"}" &
done; wait                       # exactly one 202, four 409
curl -s localhost:8080/events/$EV/availability
```

Watch the guard in Postgres:

```bash
docker compose exec postgres psql -U postgres -d inventory -c "select * from stock where event_id='$EV'"
docker compose exec postgres psql -U postgres -d inventory -c "update stock set available = -1 where event_id='$EV'"   # rejected by stock_available_range
```

Slow Inventory to widen the race window: `Demo__DelayMs=300` on inventory-api (reserve only). Run the unit proof with `dotnet test tests/Inventory.Api.Tests --filter "FullyQualifiedName~Twenty_parallel"` (needs Docker).

## Trade-offs and what we did NOT do

- **No distributed lock.** The stock row is the single source of truth in one database, so the database's row lock is the lock; Redis locks add lease expiry and clock problems for no gain.
- Contention is per event row: a hot event serializes its reserves. Fine at this scale; sharded counters or queues would be the next step.
- Cache is never used for stock: availability reads go to Inventory directly ([03-caching.md](03-caching.md)), because a stale count would mislead, though the atomic update still protects correctness.
- No seat-level model: tickets are a count, numbered only after payment.
- Read Committed is the Postgres default; the single-statement guard is why we need nothing stronger (no `SERIALIZABLE` retries).

## Check yourself

1. Why is `SELECT available` followed by `UPDATE` unsafe even inside a transaction (at Read Committed)?
2. What do "0 rows affected" and the CHECK constraint each protect against?
3. Why does the reserve rollback matter after the reservation INSERT succeeded?
4. Why is a distributed lock unnecessary here?

<details><summary>Answers</summary>

1. Both transactions can read 1 before either writes; the transaction does not lock the row on a plain SELECT, so both then decrement.
2. 0 rows is the normal "lost the race" signal producing 409; the CHECK is a last line of defense making negative or over-capacity stock impossible if a guard is ever bypassed.
3. Otherwise a reservation row would exist without the stock being taken, and a retry would see it as an existing reservation (idempotent replay) and "succeed" falsely.
4. All stock for an event lives in one Postgres row; its row lock already serializes writers atomically.
</details>

## Further reading

- PostgreSQL docs: "Explicit locking", transaction isolation and `ON CONFLICT`.
- "Lost update" and "write skew" anomalies (Kleppmann, *DDIA*, ch. 7); Martin Kleppmann's "How to do distributed locking".
- Next: [09-resilience-patterns.md](09-resilience-patterns.md); earlier: [07-saga-and-compensation.md](07-saga-and-compensation.md); the wider picture in [tech-plan.md](../project/tech-plan.md).
