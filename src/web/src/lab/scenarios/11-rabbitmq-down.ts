import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

export const rabbitmqDown: Scenario = {
  slug: 'rabbitmq-down',
  number: 11,
  title: 'RabbitMQ down',
  summary: 'Transactional outbox: with the broker stopped the order is still accepted; its event waits in the outbox and is published once RabbitMQ is back.',
  guides: [guides.outbox],
  code: [code.outboxPublisher, code.createOrder],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 0 } },
  steps: [
    {
      title: 'Broker down, place an order',
      do: 'Toggle RabbitMQ off, then POST /orders.',
      see: '202 pending as usual. The Outbox tab shows OrderCreated with published_at empty; every second the publisher tries and logs that RabbitMQ is unavailable.',
      why: 'The request only writes to Postgres (order + outbox row in one transaction), so the broker is not on the request path and its outage does not fail the order.',
      actions: [{ type: 'setToggle', key: 'rabbitmqUp', value: false }, placeOrder('outbox-1', 1, 'order')],
      runMs: 4_000,
    },
    {
      title: 'Broker back',
      do: 'Toggle RabbitMQ on.',
      see: 'On the next poll the row is published (published_at set), the Worker pays the order and the ticket is created.',
      why: 'Nothing was lost and nobody had to replay anything: the outbox row is the durable record that the event still has to be sent.',
      actions: [{ type: 'setToggle', key: 'rabbitmqUp', value: true }],
      runMs: 3_000,
    },
  ],
  questions: [
    { q: 'The publisher crashes after publishing but before setting published_at. What happens?', a: 'The row is published again on the next poll: a duplicate delivery. Consumers are idempotent, so it is harmless (scenario 12).' },
    { q: 'Why FOR UPDATE SKIP LOCKED when selecting outbox rows?', a: 'Several Order.Api instances can run the publisher; SKIP LOCKED lets each take different rows instead of waiting or publishing the same ones.' },
    { q: 'Does the outbox guarantee exactly-once delivery?', a: 'No, at-least-once. Exactly-once effects come from at-least-once delivery plus idempotent consumers.' },
  ],
}
