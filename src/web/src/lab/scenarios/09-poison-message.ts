import { config } from '../engine'
import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

export const poisonMessage: Scenario = {
  slug: 'poison-message',
  number: 9,
  title: 'Poison message',
  summary: `The notification handler always fails: the message is redelivered up to ${config.maxDeliveries} times, then moved to notification-dlq.`,
  guides: [guides.broker, guides.resilience],
  code: [code.queueConsumer, code.notificationConsumer],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 0, notificationErrorRate: 1 } },
  steps: [
    {
      title: 'Order, payment, then the notification fails',
      do: 'Notification error rate is 1.0. POST /orders.',
      see: 'The order is paid normally. PaymentSucceeded reaches notification-queue, the handler throws, and the Worker nacks it (requeue). Queues tab: delivery 1/5.',
      why: 'A failed handler must not lose the message, so it goes back on the queue. Payment is not affected: it is a different queue and consumer.',
      actions: [placeOrder('poison-1', 1, 'order')],
      runMs: 3_000,
    },
    {
      title: 'Redeliveries, then the DLQ',
      do: 'Let the consumer retry.',
      see: `The delivery count climbs 2, 3, 4, ${config.maxDeliveries}. After the ${config.maxDeliveries}th failure the message moves to notification-dlq and notification-queue is empty. No tickets were created.`,
      why: `Without a limit a poison message would loop forever and block or slow the queue. The quorum queue's delivery limit (${config.maxDeliveries}) dead-letters it so an operator can inspect and replay it.`,
      runMs: 10_000,
    },
  ],
  questions: [
    { q: 'Why does the consumer wait between failed deliveries?', a: `It backs off (${config.consumerErrorDelayMs / 1000} s after an error) so a failing handler does not spin the CPU and flood the logs.` },
    { q: 'How do you get the tickets created once the bug is fixed?', a: 'Move the message from notification-dlq back to notification-queue (RabbitMQ shovel or UI). The handler is idempotent (ON CONFLICT DO NOTHING), so replaying is safe.' },
    { q: 'Is the order affected by the DLQ?', a: 'No: it is already paid. Only the notification step (tickets + email) is stuck.' },
  ],
}
