# Microservices and Vertical Slice Architecture

**In one sentence:** SuperTickets splits one business (selling tickets) into four small deployables that each own their data, and inside each deployable organizes code by feature ("vertical slices") instead of by technical layer, so you can see both how to cut a system apart and how to keep each piece easy to change.

## The problem

You run ticketing as one big app and one database. On release day a marketing push floods `GET /events`; the same process also takes payments, so checkout slows down and the whole app is restarted to scale. A schema change to `events` needs a coordinated deploy of everything, and a slow report query locks tables the checkout path needs. One team's bug takes all the features down together.

## The concept

**Monolith**: one deployable, one database. Simple to build and debug, but everything scales, deploys and fails together.

**Microservices**: several deployables, each owning one business capability and *its own data*. The price is the network: calls can be slow or fail, and you can no longer use one transaction across services.

**Database per service**: no service reads another's tables. Data crosses a boundary only through an API (sync) or an event (async).

```
 sync HTTP  (need an answer now)         async event (can happen later)
 Order ──reserve──▶ Inventory            Order ──OrderCreated──▶ broker ──▶ Worker
```

Rule of thumb: use sync HTTP when the caller cannot continue without the answer (is there stock?), and events when the work can finish later and the caller should not wait or fail with it (take payment, send confirmation).

**Vertical Slice Architecture (VSA)** vs layered: a layered app groups by technical role (`Controllers/`, `Services/`, `Repositories/`), so one change touches every folder. A vertical slice groups by use case: one folder holds the endpoint, handler, request/response and validation for *one* feature. Changes stay local; features do not share abstractions unless they must.

## How SuperTickets applies it

| Service | Owns | Boundary |
|---|---|---|
| [Catalog.Api](../../src/Catalog.Api/Program.cs) | `catalog` DB, Redis cache | Events CRUD/search; calls Inventory to set capacity |
| [Inventory.Api](../../src/Inventory.Api/Program.cs) | `inventory` DB | Stock and reservations, atomic and idempotent |
| [Order.Api](../../src/Order.Api/Program.cs) | `orders` DB | Orders, outbox publisher, sweeper |
| [Worker](../../src/Worker/WorkerServices.cs) | `orders` DB (via `Order.Data`) | Payment and notification handlers |

Full table: [tech-plan.md › Services](../project/tech-plan.md#services). Three databases live on one Postgres server for convenience, but each service only has a connection string to its own (`ConnectionStrings__Catalog`, `__Inventory`, `__Orders` in [contracts.md › Configuration](../project/contracts.md#configuration)).

**Sync vs async here.** `POST /orders` calls Inventory over HTTP because the answer decides the response (`202` or `409 sold_out`): see `CreateOrder.Handle` in [CreateOrder.cs](../../src/Order.Api/Features/CreateOrder/CreateOrder.cs) and the `InventoryClient` next to it. Payment and tickets are asynchronous: the order handler only writes an `OrderCreated` row to the outbox, and [`PaymentConsumer`](../../src/Worker/Features/ProcessPayment/PaymentConsumer.cs) and [`NotificationConsumer`](../../src/Worker/Features/SendNotification/NotificationConsumer.cs) pick it up later ([04](04-message-broker.md), [05](05-transactional-outbox.md)). The client gets `pending` immediately and polls.

**Slices.** Each service has a `Features/` folder, one subfolder per use case:

```
Catalog.Api/Features/   CreateEvent  GetEvent  ListEvents  UpdateEvent
Inventory.Api/Features/ GetAvailability  ReserveStock  ReleaseReservation  SetCapacity
Order.Api/Features/     CreateOrder  GetOrder  ExpirePending (Sweeper)
Worker/Features/        ProcessPayment  SendNotification
```

Each slice exposes a static `Map(...)` that `Program.cs` calls (for example `CreateOrder.Map(app)`), and the handler uses `OrderDbContext`, Redis or `NpgsqlDataSource` directly: no mediator, no repository layer. Look at [ReserveStock.cs](../../src/Inventory.Api/Features/ReserveStock/ReserveStock.cs): validation, demo toggles, SQL and result mapping are all in one file. Cross-feature helpers live in each service's `Common/` (`InventoryClient`, `Problems`, health checks). Rules: [tech-plan.md › Code structure](../project/tech-plan.md#code-structure).

**Shared projects: only two.**
- [`SuperTickets.Shared`](../../src/SuperTickets.Shared): infrastructure plumbing every service needs ([`CorrelationId.cs`](../../src/SuperTickets.Shared/CorrelationId.cs), the outbox, RabbitMQ topology, message records in `Messaging/Contracts`). Message records are the *contract*; sharing them keeps publisher and consumer in sync.
- [`Order.Data`](../../src/Order.Data/OrderDbContext.cs): the `orders` DbContext, entities and migrations, referenced by `Order.Api` and `Worker`.

**Why `Order.Data` is a deliberate trade-off.** The Worker's payment handler must update the order row and insert a `payments` row and an outbox row in *one local transaction*; calling Order.Api over HTTP for that would bring back a dual-write problem. So two deployables share one schema. The cost is real coupling: a migration affects both, and only Order.Api runs it (the Worker never migrates, which is why `worker` has `depends_on: order-api` in [docker-compose.yml](../../docker-compose.yml)). In a stricter design the Worker would live inside Order or talk to it through an API. We accept the coupling to keep transactions simple and the code small.

## Try it

```bash
docker compose up --build -d --wait
docker compose ps                       # 4 app services + gateway, web, postgres, redis, rabbitmq
docker compose exec postgres psql -U postgres -c '\l'     # catalog, inventory, orders
docker compose exec postgres psql -U postgres -d inventory -c '\dt'   # only stock, reservations
# sync boundary: stop Inventory and watch ordering fail while browsing still works
docker compose stop inventory-api
curl -s localhost:8080/events | head -c 200
docker compose start inventory-api
```

## Trade-offs and what we did NOT do

- Four deployables for a tiny domain is more moving parts than a monolith; it exists to teach, not because the load needs it ([business-plan.md](../project/business-plan.md)).
- One Postgres server hosts all databases: the *logical* boundary holds, the *failure* boundary does not.
- No mediator, repositories or generic abstractions; interfaces appear only when a feature must swap a dependency.
- No cross-service transactions: consistency across services is handled by idempotency, the outbox and compensation ([06](06-idempotency.md), [07](07-saga-and-compensation.md)).

## Check yourself

1. Why does `POST /orders` call Inventory synchronously but payment is asynchronous?
2. What would break if Catalog read the `inventory` database directly?
3. Why must the Worker not run EF migrations?
4. What is the downside of `Order.Data` being shared?

<details><summary>Answers</summary>

1. The HTTP response depends on the stock answer (`202` vs `409`); payment can finish later without blocking the user.
2. Inventory could no longer change its schema or invariants freely, and the atomic reserve logic could be bypassed.
3. Order.Api owns the `orders` schema; two migrators racing at startup is unsafe, hence the compose `depends_on`.
4. Deployables are coupled through the schema, so a model change requires coordinated deploys.
</details>

## Further reading

- Sam Newman, *Building Microservices* (database per service, service boundaries)
- Jimmy Bogard, "Vertical Slice Architecture"
- Chris Richardson, *Microservices Patterns* (shared database anti-pattern)

Next: [02 API gateway and load balancer](02-api-gateway-and-load-balancer.md) · All guides: [case-studies.md](case-studies.md)
