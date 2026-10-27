import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

export const idempotency: Scenario = {
  slug: 'idempotency',
  number: 6,
  title: 'Idempotency-Key',
  summary: 'The same key sent three times returns the same order and writes one OrderCreated; a missing key is rejected with 400.',
  guides: [guides.idempotency],
  code: [code.createOrder, code.reserveStock],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 0 } },
  steps: [
    {
      title: 'Double click',
      do: 'Two POST /orders for 2 tickets with the same Idempotency-Key idem-1, at the same moment.',
      see: 'Both get 202 with the same order id. One INSERT creates the order; the other finds it by idempotency_key (or loses the unique-index race and reads the winner). Inventory reserves once (stock 10 → 8).',
      why: 'The unique idempotency_key column turns "create" into "create or return the existing one". The client generates one key per checkout and reuses it on every retry.',
      actions: [placeOrder('idem-1', 2, 'click-1'), placeOrder('idem-1', 2, 'click-2')],
      runMs: 1_500,
    },
    {
      title: 'Retry after a lost response',
      do: 'POST /orders again with idem-1 (as if the first response never arrived).',
      see: 'Same order id again, still one row in orders and one OrderCreated in the outbox. Stock is still 8, not 6.',
      why: 'Retries are only safe because the operation is idempotent. Reserve and release are idempotent too, keyed by orderId.',
      actions: [placeOrder('idem-1', 2, 'retry')],
      runMs: 2_000,
    },
    {
      title: 'No key',
      do: 'POST /orders without the Idempotency-Key header.',
      see: '400 Problem Details before anything is written.',
      why: 'Without a key the server cannot tell a retry from a new purchase, so it refuses instead of guessing.',
      actions: [placeOrder(null, 2, 'no-key')],
      runMs: 200,
    },
  ],
  questions: [
    { q: 'Where is the Idempotency-Key generated, and when does it change?', a: 'In the browser, once per checkout (stored with the cart). Retries of that checkout reuse it; a new checkout gets a new key.' },
    { q: 'The retry uses the same key but quantity 5. What happens?', a: 'The payload is not compared: the original order (quantity 2) is returned.' },
    { q: 'Why is the second concurrent request not a duplicate-key error?', a: 'Order looks the key up and inserts when absent. If a concurrent insert wins the unique index, the loser catches the violation and reads the winner\'s row instead of failing.' },
  ],
}
