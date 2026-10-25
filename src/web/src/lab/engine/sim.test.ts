import { describe, expect, it } from 'vitest'
import { config, createSim, type Sim, type SimEvent, type SimOptions } from './index'

// The same invariants the backend tests and scripts/smoke.sh check (docs/project/lab-plan.md#done).

const EVENT = 'evt-1'
const DAY = 24 * 60 * 60_000

function sim(opts: SimOptions & { total?: number } = {}) {
  const { total = 10, ...rest } = opts
  return createSim({
    seed: 7,
    events: [{ id: EVENT, name: 'Lab Show', venue: 'Lab Arena', totalTickets: total, price: 25 }],
    ...rest,
    toggles: { paymentFailureRate: 0, ...rest.toggles },
  })
}

function order(s: Sim, key: string, quantity = 1, requestId = key) {
  s.dispatch({
    type: 'request', requestId, method: 'POST', path: '/orders',
    headers: { 'Idempotency-Key': key }, body: { eventId: EVENT, quantity, customerEmail: 'lab@example.com' },
  })
}

function get(s: Sim, path: string, requestId: string, headers?: Record<string, string>) {
  s.dispatch({ type: 'request', requestId, method: 'GET', path, headers })
}

const res = (s: Sim, id: string) => s.state.requests.find((r) => r.id === id)!.response!
const body = <T = Record<string, unknown>>(s: Sim, id: string) => res(s, id).body as T
const available = (s: Sim) => s.state.inventory.stock.find((x) => x.eventId === EVENT)!.available
const theOrder = (s: Sim) => s.state.orders.orders[0]

describe('happy path', () => {
  it('drives OrderCreated → payment → PaymentSucceeded → tickets', () => {
    const s = sim()
    order(s, 'k1', 2)
    const events = s.advance(5_000)

    expect(res(s, 'k1').status).toBe(202)
    expect(theOrder(s).status).toBe('paid')
    expect(s.state.orders.tickets.map((t) => t.number)).toEqual([1, 2])
    expect(available(s)).toBe(8)
    expect(s.state.orders.outbox.map((r) => [r.type, r.publishedAt !== null])).toEqual([['OrderCreated', true], ['PaymentSucceeded', true]])
    expect(s.state.broker.queues['payment-queue']).toHaveLength(0)
    expect(s.state.broker.queues['notification-queue']).toHaveLength(0)

    const kinds = events.map((e) => e.kind)
    for (const k of ['http', 'sql', 'publish', 'deliver', 'ack'] as const) expect(kinds).toContain(k)
    // One correlation id follows the order from the HTTP call through both messages.
    const cid = res(s, 'k1').headers['X-Correlation-Id']
    expect(events.filter((e) => e.kind === 'deliver').every((e) => e.correlationId === cid)).toBe(true)
  })
})

describe('concurrency', () => {
  it('last ticket: 20 concurrent orders, one winner', () => {
    const s = sim({ total: 1 })
    for (let i = 0; i < 20; i++) order(s, `k${i}`)
    s.advance(1_000)

    const statuses = Array.from({ length: 20 }, (_, i) => res(s, `k${i}`).status)
    expect(statuses.filter((x) => x === 202)).toHaveLength(1)
    expect(statuses.filter((x) => x === 409)).toHaveLength(19)
    expect(available(s)).toBe(0)
    expect(s.state.orders.orders.filter((o) => o.cancelReason === 'sold_out')).toHaveLength(19)
  })
})

describe('idempotency', () => {
  it('same Idempotency-Key returns the same order and writes one OrderCreated', () => {
    const s = sim()
    order(s, 'same', 1, 'a')
    order(s, 'same', 1, 'b') // concurrent replay
    s.advance(100)
    order(s, 'same', 1, 'c') // later replay
    s.advance(5_000)

    const ids = ['a', 'b', 'c'].map((id) => body(s, id).id)
    expect(new Set(ids).size).toBe(1)
    expect(['a', 'b', 'c'].map((id) => res(s, id).status)).toEqual([202, 202, 202])
    expect(s.state.orders.orders).toHaveLength(1)
    expect(s.state.orders.outbox.filter((r) => r.type === 'OrderCreated')).toHaveLength(1)
    expect(available(s)).toBe(9)
  })

  it('rejects a missing key', () => {
    const s = sim()
    s.dispatch({ type: 'request', requestId: 'r', method: 'POST', path: '/orders', body: { eventId: EVENT, quantity: 1, customerEmail: 'a@b.com' } })
    s.advance(100)
    expect(res(s, 'r').status).toBe(400)
  })

  it('duplicate deliveries create one payment and quantity tickets', () => {
    const s = sim()
    order(s, 'k1', 3)
    s.advance(5_000)
    for (const row of s.state.orders.outbox) s.dispatch({ type: 'redeliver', messageId: row.id })
    s.advance(5_000)

    expect(s.state.orders.payments).toHaveLength(1)
    expect(s.state.orders.outbox.filter((r) => r.type === 'PaymentSucceeded')).toHaveLength(1)
    expect(s.state.orders.tickets).toHaveLength(3)
    expect(s.state.broker.queues['payment-queue']).toHaveLength(0)
  })
})

describe('saga', () => {
  it('payment failure cancels the order and restores stock', () => {
    const s = sim({ toggles: { paymentFailureRate: 1 } })
    order(s, 'k1', 4)
    const events = s.advance(5_000)

    expect(theOrder(s)).toMatchObject({ status: 'cancelled', cancelReason: 'payment_failed' })
    expect(available(s)).toBe(10)
    expect(s.state.inventory.reservations[0].status).toBe('released')
    expect(events.some((e) => e.kind === 'publish' && e.label.includes('PaymentFailed') && e.label.includes('no queue bound'))).toBe(true)
  })

  it('worker down: the sweeper expires the pending order and releases stock', () => {
    const s = sim({ toggles: { workerUp: false } })
    order(s, 'k1', 2)
    s.advance(60_000)
    expect(theOrder(s).status).toBe('pending')
    expect(available(s)).toBe(8)

    s.advance(config.pendingTimeoutMs)
    expect(theOrder(s)).toMatchObject({ status: 'cancelled', cancelReason: 'expired' })
    expect(available(s)).toBe(10)

    // The late OrderCreated finds a non-pending order: no payment, no change.
    s.dispatch({ type: 'setToggle', key: 'workerUp', value: true })
    s.advance(5_000)
    expect(s.state.orders.payments).toHaveLength(0)
    expect(theOrder(s).status).toBe('cancelled')
  })
})

describe('broker', () => {
  it('a failing notification is dead-lettered after 5 deliveries', () => {
    const s = sim({ toggles: { notificationErrorRate: 1 } })
    order(s, 'k1')
    const events = s.advance(10_000)

    const dlq = s.state.broker.queues['notification-dlq']
    expect(dlq).toHaveLength(1)
    expect(dlq[0].deliveryCount).toBe(config.maxDeliveries)
    expect(s.state.broker.queues['notification-queue']).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'nack')).toHaveLength(config.maxDeliveries)
    expect(theOrder(s).status).toBe('paid')
    expect(s.state.orders.tickets).toHaveLength(0)
  })

  it('outbox: RabbitMQ down delays the event, nothing is lost', () => {
    const s = sim({ toggles: { rabbitmqUp: false } })
    order(s, 'k1')
    s.advance(10_000)
    expect(res(s, 'k1').status).toBe(202)
    expect(s.state.orders.outbox[0].publishedAt).toBeNull()
    expect(theOrder(s).status).toBe('pending')

    s.dispatch({ type: 'setToggle', key: 'rabbitmqUp', value: true })
    s.advance(5_000)
    expect(s.state.orders.outbox[0].publishedAt).not.toBeNull()
    expect(theOrder(s).status).toBe('paid')
    expect(s.state.orders.tickets).toHaveLength(1)
  })
})

describe('resilience', () => {
  it('timeout + retry: 503, the late reservation is reused by the same-key retry', () => {
    const s = sim({ toggles: { inventoryDelayMs: 2_500 } })
    order(s, 'k1', 2, 'first')
    const events = s.advance(10_000)

    expect(res(s, 'first').status).toBe(503)
    expect(body(s, 'first').type).toBe('dependency_unavailable')
    expect(events.filter((e) => e.kind === 'retry')).toHaveLength(config.reserveRetry.retries)
    expect(events.filter((e) => e.kind === 'timer' && e.label.includes('timed out'))).toHaveLength(3)
    expect(s.state.inventory.reservations).toHaveLength(1) // every attempt landed late; one reservation
    expect(theOrder(s).status).toBe('pending')

    s.dispatch({ type: 'setToggle', key: 'inventoryDelayMs', value: 0 })
    order(s, 'k1', 2, 'retry')
    s.advance(5_000)
    expect(res(s, 'retry').status).toBe(202)
    expect(available(s)).toBe(8)
    expect(theOrder(s).status).toBe('paid')
  })

  it('circuit breaker opens, fails fast, then closes after a successful trial', () => {
    const s = sim({ toggles: { inventoryErrorRate: 1 } })
    order(s, 'k1', 1, 'o1')
    s.advance(2_000)
    order(s, 'k2', 1, 'o2')
    s.advance(2_000)
    expect(s.state.breaker.state).toBe('open')
    expect(res(s, 'o2').status).toBe(503)

    order(s, 'k3', 1, 'o3')
    const events = s.advance(1_000)
    const r3 = s.state.requests.find((r) => r.id === 'o3')!
    expect(r3.response!.status).toBe(503)
    expect(r3.doneAt! - r3.sentAt).toBeLessThan(50) // no call, no retries
    expect(events.some((e) => e.to === 'inventory')).toBe(false)

    s.dispatch({ type: 'setToggle', key: 'inventoryErrorRate', value: 0 })
    s.advance(config.breaker.breakMs)
    order(s, 'k4', 1, 'o4')
    s.advance(2_000)
    expect(res(s, 'o4').status).toBe(202)
    expect(s.state.breaker.state).toBe('closed')
  })
})

describe('cache', () => {
  it('MISS → HIT, invalidated by an admin update, expires after the TTL', () => {
    const s = sim()
    const xcache = (id: string) => res(s, id).headers['X-Cache']
    get(s, `/events/${EVENT}`, 'g1')
    s.advance(100)
    get(s, `/events/${EVENT}`, 'g2')
    s.advance(100)
    expect([xcache('g1'), xcache('g2')]).toEqual(['MISS', 'HIT'])

    s.dispatch({
      type: 'request', requestId: 'put', method: 'PUT', path: `/admin/events/${EVENT}`, headers: { 'X-Api-Key': config.adminApiKey },
      body: { name: 'Renamed', venue: 'Lab Arena', startsAt: 30 * DAY, totalTickets: 10, price: 30 },
    })
    s.advance(100)
    expect(res(s, 'put').status).toBe(200)
    get(s, `/events/${EVENT}`, 'g3')
    s.advance(100)
    expect(xcache('g3')).toBe('MISS')
    expect(body(s, 'g3').name).toBe('Renamed')

    get(s, '/events', 'l1')
    s.advance(100)
    get(s, '/events', 'l2')
    s.advance(config.cacheTtlMs * (1 + config.cacheJitter) + 100)
    get(s, '/events', 'l3')
    s.advance(100)
    expect([xcache('l1'), xcache('l2'), xcache('l3')]).toEqual(['MISS', 'HIT', 'MISS'])
  })

  it('Redis down: falls back to Postgres, writes still work', () => {
    const s = sim({ toggles: { redisUp: false } })
    get(s, `/events/${EVENT}`, 'g1')
    get(s, '/events', 'l1')
    s.dispatch({
      type: 'request', requestId: 'post', method: 'POST', path: '/admin/events', headers: { 'X-Api-Key': config.adminApiKey },
      body: { name: 'New', venue: 'Hall', startsAt: 30 * DAY, totalTickets: 5, price: 10 },
    })
    s.advance(1_000)
    expect([res(s, 'g1').status, res(s, 'g1').headers['X-Cache']]).toEqual([200, 'MISS'])
    expect(res(s, 'l1').headers['X-Cache']).toBe('MISS')
    expect(res(s, 'post').status).toBe(201)
    expect(Object.keys(s.state.redis)).toHaveLength(0)

    s.dispatch({ type: 'setToggle', key: 'redisUp', value: true })
    get(s, `/events/${EVENT}`, 'g2')
    s.advance(100)
    get(s, `/events/${EVENT}`, 'g3')
    s.advance(100)
    expect([res(s, 'g2').headers['X-Cache'], res(s, 'g3').headers['X-Cache']]).toEqual(['MISS', 'HIT'])
  })

  it('capacity cut below reserved → 409 capacity_below_sold', () => {
    const s = sim()
    order(s, 'k1', 5)
    s.advance(5_000)
    s.dispatch({
      type: 'request', requestId: 'put', method: 'PUT', path: `/admin/events/${EVENT}`, headers: { 'X-Api-Key': config.adminApiKey },
      body: { name: 'Lab Show', venue: 'Lab Arena', startsAt: 30 * DAY, totalTickets: 4, price: 25 },
    })
    s.advance(100)
    expect(res(s, 'put').status).toBe(409)
    expect(body(s, 'put').type).toBe('capacity_below_sold')
  })

  it('admin routes need the API key', () => {
    const s = sim()
    s.dispatch({ type: 'request', requestId: 'p', method: 'POST', path: '/admin/events', body: {} })
    s.advance(100)
    expect(res(s, 'p').status).toBe(401)
  })
})

describe('gateway', () => {
  it('round-robins Catalog, routes availability to Inventory, hides /inventory', () => {
    const s = sim()
    for (let i = 0; i < 20; i++) get(s, '/events', `g${i}`)
    get(s, `/events/${EVENT}/availability`, 'av')
    get(s, '/inventory/reservations', 'inv')
    s.advance(1_000)

    const upstreams = Array.from({ length: 20 }, (_, i) => res(s, `g${i}`).headers['X-Upstream'])
    expect(upstreams.filter((u) => u === 'catalog-1')).toHaveLength(10)
    expect(upstreams.filter((u) => u === 'catalog-2')).toHaveLength(10)
    expect(res(s, 'av').headers['X-Upstream']).toBe('inventory')
    expect(body(s, 'av').available).toBe(10)
    expect(res(s, 'inv').status).toBe(404)
  })

  it('rate limit: a burst of 160 lets 1 + burst through, then drains', () => {
    const s = sim()
    s.dispatch({ type: 'burst', count: 160, path: '/events' })
    s.advance(1_000)
    const codes = s.state.requests.map((r) => r.response!.status)
    expect(codes.filter((c) => c === 200)).toHaveLength(config.rateLimit.burst + 1)
    expect(codes.filter((c) => c === 429)).toHaveLength(160 - config.rateLimit.burst - 1)

    s.advance(2_000)
    get(s, '/events', 'after')
    s.advance(100)
    expect(res(s, 'after').status).toBe(200)
  })
})

describe('determinism', () => {
  const script = (seed: number) => {
    const s = createSim({ seed, events: [{ id: EVENT, name: 'A', venue: 'B', totalTickets: 3, price: 1 }] })
    for (let i = 0; i < 5; i++) order(s, `k${i}`)
    const events: SimEvent[] = s.advance(10_000)
    return { events, state: s.state }
  }

  it('the same seed replays exactly; reset restarts', () => {
    expect(script(42)).toEqual(script(42))
    expect(script(42).state.orders.orders.map((o) => o.id)).not.toEqual(script(43).state.orders.orders.map((o) => o.id))

    const s = sim()
    order(s, 'k1')
    s.advance(5_000)
    s.reset(7)
    expect(s.state.orders.orders).toHaveLength(0)
    expect(s.state.now).toBe(0)
  })
})
