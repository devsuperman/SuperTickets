import { config } from '../engine'
import { code, guides, labEvent, placeOrder } from './common'
import type { Scenario } from './types'

const { retries, baseDelayMs, timeoutMs } = config.reserveRetry
const { failureRatio, minimumThroughput, samplingMs, breakMs } = config.breaker

export const inventorySlow: Scenario = {
  slug: 'inventory-slow',
  number: 8,
  title: 'Inventory slow or erroring',
  summary: `Timeout (${timeoutMs / 1000} s), ${retries} retries (${baseDelayMs} ms exponential), then the circuit breaker opens, fails fast for ${breakMs / 1000} s and closes after a successful trial.`,
  guides: [guides.resilience],
  code: [code.orderProgram, code.createOrder, code.reserveStock],
  options: { events: [labEvent(10)], toggles: { paymentFailureRate: 0 } },
  steps: [
    {
      title: 'Slow Inventory: timeout and retries',
      do: `Set the Inventory delay to 2.5 s (more than the ${timeoutMs / 1000} s timeout), then POST /orders.`,
      see: `Three reserve attempts, each abandoned after ${timeoutMs / 1000} s, with retries ${baseDelayMs} ms and ${baseDelayMs * 2} ms apart. The browser gets 503 dependency_unavailable after about 7 s. Open the Breaker tab: 3 failed samples.`,
      why: 'A timeout bounds how long a slow dependency can hold a request. Retrying is safe only because reserve is idempotent: the late attempts all land on Inventory, but they create a single reservation for this order.',
      actions: [{ type: 'setToggle', key: 'inventoryDelayMs', value: 2_500 }, placeOrder('slow-1', 1, 'slow')],
      runMs: 8_000,
    },
    {
      title: 'Erroring Inventory: the breaker opens',
      do: 'Delay back to 0, error rate 1.0, POST /orders.',
      see: `Reserve fails with 500. After ${minimumThroughput} samples with ≥ ${failureRatio * 100} % failures in ${samplingMs / 1000} s the circuit opens: the last retry is rejected without calling Inventory. 503.`,
      why: 'The breaker stops hammering a dependency that is clearly down, which gives it room to recover and keeps Order\'s threads free.',
      actions: [
        { type: 'setToggle', key: 'inventoryDelayMs', value: 0 },
        { type: 'setToggle', key: 'inventoryErrorRate', value: 1 },
        placeOrder('error-1', 1, 'error'),
      ],
      runMs: 1_000,
    },
    {
      title: 'Open circuit: fail fast',
      do: 'POST /orders again.',
      see: '503 in a few ms: no hop reaches Inventory, no retries.',
      why: 'Failing fast is better than making every user wait for timeouts that will fail anyway.',
      actions: [placeOrder('fast-1', 1, 'fast')],
      runMs: 1_000,
    },
    {
      title: 'Inventory recovers',
      do: `Set the error rate to 0 and wait the ${breakMs / 1000} s break.`,
      see: 'Nothing calls Inventory while the circuit is open; the Breaker tab counts down to half-open.',
      why: 'The breaker does not poll; the next real call after the break is the probe.',
      actions: [{ type: 'setToggle', key: 'inventoryErrorRate', value: 0 }],
      runMs: breakMs,
      fastForward: true,
    },
    {
      title: 'Half-open trial closes the circuit',
      do: 'POST /orders.',
      see: 'The breaker lets one trial call through (half-open). It succeeds, the circuit closes and the order is accepted (202) and paid.',
      why: 'One success is enough to trust the dependency again; a failed trial would reopen the circuit for another break.',
      actions: [placeOrder('trial-1', 1, 'trial')],
      runMs: 2_000,
    },
  ],
  questions: [
    { q: 'The first order timed out, yet Inventory has a reservation for it. Is that a leak?', a: 'No: the order stays pending, so a retry with the same key reuses the reservation, and if the client gives up the sweeper expires the order and releases it (scenario 10).' },
    { q: 'Why does the retry wrap the breaker and not the other way round?', a: 'Every attempt is recorded by the breaker, and once it opens the retry stops immediately (BrokenCircuitException is not retried).' },
    { q: 'Why 503 and not 500 when Inventory is down?', a: '503 dependency_unavailable tells the client the problem is temporary and on the server side, so retrying later with the same key is the right move.' },
  ],
}
