import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

export const RACERS = 20

export const lastTicket: Scenario = {
  slug: 'last-ticket',
  number: 5,
  title: 'Last-ticket race',
  summary: `One ticket left, ${RACERS} concurrent orders: the conditional UPDATE lets exactly one win; the rest get 409 sold_out.`,
  guides: [guides.concurrency],
  code: [code.reserveStock, code.createOrder],
  options: { events: [labEvent(1)], toggles: { paymentFailureRate: 0 } },
  steps: [
    {
      title: `${RACERS} buyers, 1 ticket`,
      do: `${RACERS} POST /orders at the same moment, each with its own Idempotency-Key.`,
      see: `In the log, every reserve runs UPDATE stock … WHERE available >= 1. One reports 1 row (201 → 202 to the browser); the other ${RACERS - 1} report 0 rows (409 → their orders are cancelled with sold_out). Stock ends at 0, never below.`,
      why: 'The check and the decrement are one atomic statement, so no two transactions can both see "1 left". Reading the stock first and updating later (check-then-act) is exactly the race that oversells.',
      actions: Array.from({ length: RACERS }, (_, i) => placeOrder(`race-${i + 1}`, 1, `race-${i + 1}`)),
      runMs: 500,
    },
    {
      title: 'The winner is paid',
      do: 'Let the outbox and Worker run.',
      see: 'Only the winning order gets OrderCreated, a payment and a ticket. The losers stay cancelled with no outbox row.',
      why: 'Losers never wrote an event, so nothing downstream has to undo them.',
      runMs: 2_500,
    },
  ],
  questions: [
    { q: 'Why not SELECT available, check it in C#, then UPDATE?', a: 'Two requests can both read 1 before either writes. The single UPDATE … WHERE available >= qty makes Postgres serialize them on the row.' },
    { q: 'What else stops stock from going negative if a bug slips in?', a: 'A CHECK constraint (stock_available_range) on the column: the database rejects any write below 0.' },
    { q: 'A loser retries with the same Idempotency-Key. What does it get?', a: '202 with its existing order, already cancelled with sold_out; Order does not try to reserve again.' },
  ],
}
