import { config } from '../engine'
import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

const minutes = config.pendingTimeoutMs / 60_000
const sweepSeconds = config.sweepIntervalMs / 1000

export const workerCrash: Scenario = {
  slug: 'worker-crash',
  number: 10,
  title: 'Worker crash',
  summary: `Nobody pays the order: it stays pending until the sweeper (every ${sweepSeconds} s) expires it after ${minutes} min and releases the stock.`,
  guides: [guides.saga, guides.resilience],
  code: [code.sweeper, code.paymentConsumer],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 0 } },
  steps: [
    {
      title: 'Worker down, place an order',
      do: 'Toggle the Worker off, then POST /orders for 2 tickets.',
      see: '202 pending, stock 10 → 8. OrderCreated is published and waits in payment-queue: no consumer.',
      why: 'The broker keeps the message, but the order cannot wait forever: the seats are held for someone who may never pay.',
      actions: [{ type: 'setToggle', key: 'workerUp', value: false }, placeOrder('crash-1', 2, 'order')],
      runMs: 2_000,
    },
    {
      title: `Fast-forward ${minutes} minutes`,
      do: `Let the clock run ${minutes} min ${sweepSeconds} s.`,
      see: `The sweeper runs every ${sweepSeconds} s. Once the order is older than ${minutes} min it releases the reservation (stock back to 10) and sets cancelled / expired.`,
      why: 'Expiry is the saga\'s safety net for lost messages, crashed workers and abandoned clients: something must eventually finish every pending order.',
      runMs: config.pendingTimeoutMs + config.sweepIntervalMs,
      fastForward: true,
    },
    {
      title: 'The Worker comes back',
      do: 'Toggle the Worker on.',
      see: 'It consumes the old OrderCreated, but UPDATE … WHERE status = \'pending\' touches 0 rows: no payment, no PaymentSucceeded. The message is acked.',
      why: 'State-guarded updates make late messages harmless: the first final state wins, everything after it is a no-op.',
      actions: [{ type: 'setToggle', key: 'workerUp', value: true }],
      runMs: 2_000,
    },
  ],
  questions: [
    { q: 'Why does the sweeper release first and cancel second?', a: 'If release fails it simply retries on the next sweep while the order is still pending. Cancelling first could leave a cancelled order holding seats.' },
    { q: 'What if the Worker pays the order at the same moment the sweeper expires it?', a: 'Both updates run WHERE status = \'pending\'; Postgres lets only one change the row, the other sees 0 rows and does nothing.' },
    { q: 'Why keep the message in payment-queue instead of dropping it when the Worker is down?', a: 'Most outages are short; the message is processed as soon as the Worker returns. Expiry only covers the long tail.' },
  ],
}
