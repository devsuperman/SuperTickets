import { describe, expect, it } from 'vitest'
import { config, type Sim } from '../engine'
import { paymentFailure } from './07-payment-failure'
import { inventorySlow } from './08-inventory-slow'
import { poisonMessage } from './09-poison-message'
import { workerCrash } from './10-worker-crash'
import { rabbitmqDown } from './11-rabbitmq-down'
import { duplicateDelivery } from './12-duplicate-delivery'
import { EVENT_ID } from './common'
import { scenarios } from './index'
import { runScenario } from './run'

// Each scenario runs to its "Must show" outcome with the default seed (docs/project/lab-plan.md#scenarios).

const request = (s: Sim, id: string) => s.state.requests.find((r) => r.id === id)!
const res = (s: Sim, id: string) => request(s, id).response!
const body = (s: Sim, id: string) => res(s, id).body as Record<string, unknown>
const available = (s: Sim) => s.state.inventory.stock.find((x) => x.eventId === EVENT_ID)!.available

describe('07 payment failure', () => {
  it('cancelled / payment_failed, reservation released, stock restored', () => {
    const { sim, stepEvents } = runScenario(paymentFailure)

    expect(res(sim, 'order').status).toBe(202)
    expect(sim.state.orders.orders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'payment_failed' })
    expect(sim.state.inventory.reservations[0].status).toBe('released')
    expect(available(sim)).toBe(10)
    expect(stepEvents[1].some((e) => e.kind === 'publish' && e.label.includes('PaymentFailed'))).toBe(true)
    expect(body(sim, 'status')).toMatchObject({ status: 'cancelled', cancelReason: 'payment_failed', tickets: [] })
  })
})

describe('08 inventory slow / erroring', () => {
  it('timeout + 2 retries → 503; breaker opens, fails fast, half-open trial closes it', () => {
    const { sim, stepEvents } = runScenario(inventorySlow)
    const [slow, erroring, fast, , trial] = stepEvents

    expect(res(sim, 'slow').status).toBe(503)
    expect(body(sim, 'slow').type).toBe('dependency_unavailable')
    expect(slow.filter((e) => e.kind === 'timer' && e.label.includes('timed out'))).toHaveLength(config.reserveRetry.retries + 1)
    expect(slow.filter((e) => e.kind === 'retry').map((e) => e.label)).toEqual(['retry 1/2 in 200 ms', 'retry 2/2 in 400 ms'])

    expect(res(sim, 'error').status).toBe(503)
    expect(erroring.some((e) => e.kind === 'breaker' && e.label.startsWith('circuit OPEN'))).toBe(true)

    const f = request(sim, 'fast')
    expect(f.response!.status).toBe(503)
    expect(f.doneAt! - f.sentAt).toBeLessThan(50)
    expect(fast.some((e) => e.to === 'inventory')).toBe(false)

    expect(trial.some((e) => e.kind === 'breaker' && e.label.includes('half-open'))).toBe(true)
    expect(trial.some((e) => e.kind === 'breaker' && e.label.startsWith('circuit closed'))).toBe(true)
    expect(res(sim, 'trial').status).toBe(202)
    expect(sim.state.breaker.state).toBe('closed')
  })
})

describe('09 poison message', () => {
  it('delivery count 1…5, then notification-dlq', () => {
    const { sim, events } = runScenario(poisonMessage)

    const deliveries = events.filter((e) => e.kind === 'deliver' && e.label.includes('notification-queue')).map((e) => e.label)
    expect(deliveries.map((l) => l.match(/delivery (\d)\//)![1])).toEqual(['1', '2', '3', '4', '5'])
    const dlq = sim.state.broker.queues['notification-dlq']
    expect(dlq).toHaveLength(1)
    expect(dlq[0].deliveryCount).toBe(config.maxDeliveries)
    expect(sim.state.broker.queues['notification-queue']).toHaveLength(0)
    expect(sim.state.orders.orders[0].status).toBe('paid')
    expect(sim.state.orders.tickets).toHaveLength(0)
  })
})

describe('10 worker crash', () => {
  it('stays pending, then the sweeper expires it and releases stock; the late message is a no-op', () => {
    const s = runScenario({ ...workerCrash, steps: workerCrash.steps.slice(0, 1) }).sim
    expect(s.state.orders.orders[0].status).toBe('pending')
    expect(available(s)).toBe(8)

    const { sim, stepEvents } = runScenario(workerCrash)
    expect(sim.state.orders.orders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'expired' })
    expect(sim.state.inventory.reservations[0].status).toBe('released')
    expect(available(sim)).toBe(10)
    expect(stepEvents[1].some((e) => e.label.startsWith('sweeper:') && e.label.includes('→ 1 rows'))).toBe(true)
    expect(stepEvents[2].some((e) => e.kind === 'deliver' && e.label.includes('OrderCreated'))).toBe(true)
    expect(sim.state.orders.payments).toHaveLength(0)
    expect(sim.state.broker.queues['payment-queue']).toHaveLength(0)
  })
})

describe('11 RabbitMQ down', () => {
  it('the outbox row stays unpublished, then is published once the broker is back', () => {
    const first = runScenario({ ...rabbitmqDown, steps: rabbitmqDown.steps.slice(0, 1) }).sim
    expect(res(first, 'order').status).toBe(202)
    expect(first.state.orders.outbox[0].publishedAt).toBeNull()
    expect(first.state.orders.orders[0].status).toBe('pending')

    const { sim } = runScenario(rabbitmqDown)
    expect(sim.state.orders.outbox.find((r) => r.type === 'OrderCreated')!.publishedAt).not.toBeNull()
    expect(sim.state.orders.orders[0].status).toBe('paid')
    expect(sim.state.orders.tickets).toHaveLength(1)
  })
})

describe('12 duplicate delivery', () => {
  it('redelivered OrderCreated / PaymentSucceeded create no duplicates', () => {
    const { sim, stepEvents } = runScenario(duplicateDelivery)

    expect(stepEvents[1].some((e) => e.kind === 'deliver' && e.label.includes('OrderCreated'))).toBe(true)
    expect(stepEvents[2].some((e) => e.label.includes('ON CONFLICT') && e.label.includes('0 rows'))).toBe(true)
    expect(sim.state.orders.payments).toHaveLength(1)
    expect(sim.state.orders.outbox.filter((r) => r.type === 'PaymentSucceeded')).toHaveLength(1)
    expect(sim.state.orders.tickets).toHaveLength(2)
  })
})

describe('catalog', () => {
  it('has the 12 scenarios plus the sandbox, with unique slugs', () => {
    expect(scenarios.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0])
    expect(new Set(scenarios.map((s) => s.slug)).size).toBe(scenarios.length)
    for (const s of scenarios.filter((x) => x.number > 0)) {
      expect(s.steps.length).toBeGreaterThan(0)
      expect(s.questions.length).toBeGreaterThan(0)
    }
  })
})
