# Lab Plan

An interactive playground in the SPA that **simulates** SuperTickets in the browser so each concept in [docs/learn](../learn/README.md) can be triggered, watched and explained. Tasks: [tasks.md](tasks.md) T17–T21.

## Decisions

| Topic | Decision |
|---|---|
| Mode | Simulation only. No calls to the real APIs, no backend changes, works with `npm run dev` and no Compose stack. |
| Where | Inside the existing SPA at `/lab` and `/lab/:scenario`. |
| Source of truth | The model mirrors [contracts.md](contracts.md) and the resilience settings in code. When either changes, update the model in the same PR. |
| Stack | TypeScript only. UI from shadcn/ui (add with the CLI) + Tailwind; the architecture diagram is inline SVG styled with Tailwind (no diagram library). |
| Tests | Vitest for the simulation engine (pure functions, no DOM). `npm test` added to CI. |
| Determinism | Seeded RNG, so a scenario replays identically and tests are stable. |

## What the user sees

One page per scenario, same layout:

```
┌ Scenario: "Last-ticket race" ─────────────────────────── [▶ Run] [⏸] [Step] [Reset] speed ─○── ┐
│ ┌ Architecture (SVG) ───────────────────────┐ ┌ Controls ────────────────────────────────────┐ │
│ │ browser → gateway → catalog ×2 → redis    │ │ Payment failure rate   ──○────── 0.1         │ │
│ │                  → order → inventory      │ │ Inventory delay / error rate                 │ │
│ │ order → outbox → exchange → queues → worker│ │ Notification error rate                      │ │
│ │ (animated dots per message, red on error) │ │ Redis up/down · RabbitMQ up/down · Worker up │ │
│ └───────────────────────────────────────────┘ └──────────────────────────────────────────────┘ │
│ ┌ Inspector (tabs) ──────────────────────────┐ ┌ Explain ───────────────────────────────────┐ │
│ │ Orders · Stock · Reservations · Outbox ·   │ │ Do / See / Why for the current step,       │ │
│ │ Queues+DLQ · Cache keys · Breaker · Log    │ │ link to the learn guide and code file,     │ │
│ │ (rows highlight when they change)          │ │ "Check yourself" questions at the end      │ │
│ └────────────────────────────────────────────┘ └────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Plus a **sandbox** scenario: all controls free, buttons to send requests by hand (GET events, place order with a chosen `Idempotency-Key`, admin update, burst N requests).

## Scenarios

Same 12 as [case-studies.md](../learn/case-studies.md), one script each.

| # | Scenario | Script | Must show |
|---|---|---|---|
| 1 | Happy path | One order | `pending` → reserve → outbox row → published → `payment-queue` → `paid` + outbox → `notification-queue` → tickets |
| 2 | Cache | GET event ×2, admin update, GET | MISS → HIT → `DEL` + `INCR catalog:version` → MISS; jittered TTL countdown |
| 3 | Redis down | Toggle Redis off, GET | Fallback to Postgres, always MISS, health "degraded" |
| 4 | Load balancer + rate limit | 20 GETs, then burst 160 | Round-robin per `X-Upstream`; 200 vs 429 counts (50 rps, burst 100) |
| 5 | Last-ticket race | Event with 1 ticket, 2–20 concurrent orders | Conditional `UPDATE ... available >= qty`: one 202, rest 409 `sold_out` |
| 6 | Idempotency | Same key ×3, then missing key | Same order id, one outbox row; 400 without key |
| 7 | Payment failure | Failure rate 1.0, one order | `cancelled`/`payment_failed`, release, stock restored |
| 8 | Inventory slow/erroring | Delay > 2 s or error rate 1.0, several orders | Timeout, 2 retries (200 ms exp.), breaker opens (≥ 50 % of ≥ 5 calls in 30 s), 503 fast for 15 s, half-open |
| 9 | Poison message | Notification error rate 1.0 | Delivery count 1…5, then `notification-dlq` |
| 10 | Worker crash | Worker down, order, fast-forward | Order stays `pending`; sweeper (every 30 s, older than 5 min) → `cancelled`/`expired`, stock released |
| 11 | RabbitMQ down | Broker down, order, broker up | Outbox row stays unpublished, then published once broker is back |
| 12 | Duplicate delivery | Redeliver `OrderCreated` / `PaymentSucceeded` | Reused `payments` row, `ON CONFLICT DO NOTHING` tickets: no duplicates |

## Simulation engine

`src/web/src/lab/engine/`: pure TypeScript, no React. A discrete-event simulation over a virtual clock (ms), so "5 minutes" can be fast-forwarded.

```ts
type NodeId = 'browser' | 'gateway' | 'catalog-1' | 'catalog-2' | 'redis' | 'inventory'
  | 'order' | 'rabbitmq' | 'worker' | 'postgres'

type SimEvent = {           // one arrow in the diagram, one line in the log
  t: number                 // virtual ms
  from: NodeId; to: NodeId
  kind: 'http' | 'response' | 'sql' | 'cache' | 'publish' | 'deliver' | 'ack' | 'nack' | 'dlq' | 'timer'
  label: string             // e.g. "POST /inventory/reservations", "UPDATE stock ... 0 rows"
  correlationId?: string
  status?: number
  explain?: string          // key into the scenario's explanation text
}

type Action =               // what the user (or a scenario script) can do
  | { type: 'request'; method: string; path: string; headers?: Record<string, string>; body?: unknown }
  | { type: 'burst'; count: number; path: string }
  | { type: 'setToggle'; key: keyof Toggles; value: number | boolean }
  | { type: 'redeliver'; queue: string; messageId: string }

interface Sim {
  readonly state: SimState  // snapshot for the inspector
  dispatch(action: Action): void
  advance(ms: number): SimEvent[]   // run the clock, return what happened
  reset(seed: number): void
}
```

`SimState` holds what the real stores hold, with the [schemas](contracts.md#databases) column names: `events`, `stock`, `reservations`, `orders`, `payments`, `tickets`, `outbox`, Redis keys with expiry, queues and DLQs (messages with delivery count), breaker (`closed | open | half-open`, window samples, opened at), rate-limit bucket, toggles, per-service up/down.

One module per service, mirroring the real feature folders so a reader can map the model to the code:

| Module | Mirrors | Parameters (from code) |
|---|---|---|
| `gateway.ts` | `infra/nginx/nginx.conf` | routing table, round-robin, 50 rps / burst 100, `/inventory` → 404 |
| `catalog.ts` | `Catalog.Api/Features`, `Common/EventCache.cs` | TTL 60 s ± 10 %, version key, Redis timeout 1 s → fallback |
| `inventory.ts` | `Inventory.Api/Features` | reserve/release/capacity SQL rules, demo delay/error on reserve |
| `order.ts` | `Order.Api/Features`, `Program.cs` | create-order flow, timeout 2 s, retry 2 × 200 ms exp., breaker 0.5 / 5 / 30 s / 15 s, sweeper 30 s / 5 min, outbox poll 1 s |
| `broker.ts` | `SuperTickets.Shared/Messaging` | topic routing, quorum delivery limit 5 → DLQ, consumer idle 250 ms |
| `worker.ts` | `Worker/Features` | payment (failure rate 0.1) and notification handlers, idempotent writes |

Each module opens with a comment linking to the contracts section and code file it mirrors.

## Code layout

```
web/src/
  lab/engine/       → engine, one module per service, rng, types (+ *.test.ts)
  lab/scenarios/    → one file per scenario: steps, initial state, explanations, questions
  lab/components/   → ArchitectureDiagram, Inspector, Controls, ExplainPanel, EventLog
  pages/lab/        → LabHome (scenario list), LabScenario (/lab/:scenario)
```

shadcn components to add with the CLI: `tabs`, `slider`, `switch`, `tooltip`, `accordion`, `alert`, `progress`, `chart`, `separator`.

## Done

- `npm run build`, `npm run lint` and `npm test` pass.
- Engine tests assert the same invariants the backend tests do: one winner for the last ticket, idempotent replays, DLQ after 5, breaker opens and recovers, sweeper expires and releases, outbox delivers after the broker returns, Redis-down fallback.
- Every scenario in the table runs to its "Must show" outcome with the default seed.
- Each learn guide's **Try it** links to its lab scenario.
