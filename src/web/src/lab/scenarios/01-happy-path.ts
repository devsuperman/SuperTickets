import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

export const happyPath: Scenario = {
  slug: 'happy-path',
  number: 1,
  title: 'Happy path',
  summary: 'One order end to end: reservation, outbox, payment-queue, paid, notification-queue, tickets.',
  guides: [guides.microservices, guides.broker, guides.outbox],
  code: [code.createOrder, code.reserveStock, code.outboxPublisher, code.paymentConsumer, code.notificationConsumer],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 0 } },
  steps: [
    {
      title: 'Place an order',
      do: 'POST /orders for 2 tickets with Idempotency-Key lab-1 (payment failure rate is 0 so the run is deterministic).',
      see: 'The gateway routes to Order. Order inserts a pending order, Inventory reserves 2 seats (stock 10 → 8), Order writes an OrderCreated outbox row, and the browser gets 202 with status pending.',
      why: 'The request only does the synchronous part: reserve the stock and record the event. Payment and tickets happen later, driven by messages, so the client is not kept waiting.',
      actions: [placeOrder('lab-1', 2, 'order')],
      runMs: 500,
    },
    {
      title: 'The outbox publisher ships OrderCreated',
      do: 'Wait for the next outbox poll (every 1 s).',
      see: 'Order publishes OrderCreated to payment-queue and sets published_at. The Worker picks it up, and in one transaction marks the order paid, inserts the payments row and a PaymentSucceeded outbox row, then acks.',
      why: 'Events are rows written in the same transaction as the state change; a separate publisher sends them. The Worker writes its own event to the same outbox, so the next step is published the same way.',
      runMs: 1_000,
    },
    {
      title: 'PaymentSucceeded becomes tickets',
      do: 'Wait for the next poll.',
      see: 'PaymentSucceeded goes to notification-queue. The notification handler inserts tickets 1 and 2 and logs the confirmation. Both queues end empty; both outbox rows are published.',
      why: 'Every hop carries the same X-Correlation-Id (filter the log by it). Each consumer acks only after its transaction commits: at-least-once delivery.',
      runMs: 1_500,
    },
  ],
  questions: [
    { q: 'Why does POST /orders return 202 and not 201 with a paid order?', a: 'Payment is asynchronous: the order is accepted (stock reserved, event recorded) and finishes later via the broker. 202 says "accepted, not done"; the client polls GET /orders/{id}.' },
    { q: 'Who publishes PaymentSucceeded, the Worker or Order.Api?', a: 'The Worker only inserts the outbox row in its transaction; the outbox publisher hosted by Order.Api ships every row of the shared orders database.' },
    { q: 'What would break if Order published to RabbitMQ directly inside the request?', a: 'A dual write: the broker call can succeed while the database commit fails (or the reverse), leaving a ghost event or a lost one. Scenario 11 shows the outbox avoiding it.' },
  ],
}
