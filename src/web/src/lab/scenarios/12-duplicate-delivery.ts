import type { MessageType, SimState } from '../engine'
import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

const redeliver = (type: MessageType) => (s: SimState) =>
  s.orders.outbox.filter((r) => r.type === type).map((r) => ({ type: 'redeliver' as const, messageId: r.id }))

export const duplicateDelivery: Scenario = {
  slug: 'duplicate-delivery',
  number: 12,
  title: 'Duplicate delivery',
  summary: 'OrderCreated and PaymentSucceeded are delivered twice: the payments row is reused and tickets use ON CONFLICT DO NOTHING, so nothing is duplicated.',
  guides: [guides.idempotency, guides.broker],
  code: [code.paymentConsumer, code.notificationConsumer],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 0 } },
  steps: [
    {
      title: 'A normal order',
      do: 'POST /orders for 2 tickets and let it finish.',
      see: 'paid, one payments row, tickets 1 and 2.',
      why: 'The baseline to compare the duplicates against.',
      actions: [placeOrder('dup-1', 2, 'order')],
      runMs: 3_000,
    },
    {
      title: 'OrderCreated again',
      do: 'Redeliver OrderCreated (the publisher crashed after publishing, before marking the row).',
      see: 'The Worker receives it, finds the existing payments row / non-pending order and skips: no second payment, no second PaymentSucceeded. Acked.',
      why: 'At-least-once delivery means every consumer must expect duplicates. The payment result is stored per order, so a replay reuses it instead of charging twice.',
      actions: redeliver('OrderCreated'),
      runMs: 1_500,
    },
    {
      title: 'PaymentSucceeded again',
      do: 'Redeliver PaymentSucceeded.',
      see: 'INSERT tickets 1..2 ON CONFLICT (order_id, number) DO NOTHING → 0 rows. Still exactly 2 tickets.',
      why: 'A unique key on (order_id, number) makes ticket creation idempotent without any extra bookkeeping.',
      actions: redeliver('PaymentSucceeded'),
      runMs: 1_500,
    },
  ],
  questions: [
    { q: 'Why not deduplicate in the broker instead?', a: 'Brokers give at-least-once; duplicates also come from publishers and retries. Idempotent handlers cover every source with one rule.' },
    { q: 'What makes ticket numbers 1..quantity safe to insert twice?', a: 'They are deterministic (derived from the order), so the replay produces the same keys and the unique index drops them.' },
    { q: 'Would random ticket ids per insert still be idempotent?', a: 'Only if something else is unique; with (order_id, number) as the unique key the id can be random, the number cannot.' },
  ],
}
