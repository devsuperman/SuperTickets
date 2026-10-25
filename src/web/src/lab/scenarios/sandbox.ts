import { code, guides, labEvent } from './common'
import type { Scenario } from './types'

export const sandbox: Scenario = {
  slug: 'sandbox',
  number: 0,
  title: 'Sandbox',
  summary: 'Every control free: send requests by hand, flip failures on and off, redeliver messages, and watch what happens.',
  guides: Object.values(guides),
  code: [code.nginx, code.createOrder, code.outboxPublisher, code.paymentConsumer],
  options: { events: [labEvent(10)] },
  steps: [],
  questions: [],
}
