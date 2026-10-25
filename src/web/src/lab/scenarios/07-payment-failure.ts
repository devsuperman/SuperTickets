import { code, getFirstOrder, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

export const paymentFailure: Scenario = {
  slug: 'payment-failure',
  number: 7,
  title: 'Payment failure',
  summary: 'Saga compensation: every payment is declined, the order is cancelled with payment_failed and the reserved stock is released.',
  guides: [guides.saga],
  code: [code.paymentConsumer, code.releaseReservation],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 1 } },
  steps: [
    {
      title: 'Place an order (payments always fail)',
      do: 'Payment failure rate is 1.0. POST /orders for 3 tickets.',
      see: '202 pending, a reservation, stock 10 → 7. The request does not know payment will fail: it happens later.',
      why: 'Each service commits its own step locally; there is no distributed transaction across Order, Inventory and the Worker.',
      actions: [placeOrder('saga-1', 3, 'order')],
      runMs: 500,
    },
    {
      title: 'The Worker declines and compensates',
      do: 'Let the outbox deliver OrderCreated.',
      see: 'The Worker marks the order cancelled / payment_failed and writes PaymentFailed in the same transaction, then calls Inventory to release: the reservation becomes released and stock is back to 10. PaymentFailed is published but no queue is bound to it.',
      why: 'A saga undoes earlier steps with compensating actions. Release is idempotent (keyed by orderId), so the Worker can retry it until it succeeds; the message is acked only after the release.',
      runMs: 2_000,
    },
    {
      title: 'The client sees why',
      do: 'GET /orders/{id}',
      see: 'status cancelled, cancelReason payment_failed, no tickets.',
      why: 'The order row records the outcome, so the client (polling every 2 s) can show a clear message.',
      actions: getFirstOrder('status'),
      runMs: 200,
    },
  ],
  questions: [
    { q: 'Why is there no queue bound to PaymentFailed?', a: 'Nothing needs to react to it: the Worker already cancelled the order and released the stock. It is published for observability only.' },
    { q: 'The release call to Inventory fails. What happens to the message?', a: 'The handler fails, the message is nacked and redelivered; the cancel is already committed, and the retry only repeats the idempotent release.' },
    { q: 'Could the order be paid after being cancelled?', a: 'No: every status change runs WHERE status = \'pending\', so a late or duplicate step changes nothing.' },
  ],
}
