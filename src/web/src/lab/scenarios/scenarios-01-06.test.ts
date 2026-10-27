import { describe, expect, it } from 'vitest'
import { catalogHealth, config, type Sim } from '../engine'
import { cache } from './02-cache'
import { happyPath } from './01-happy-path'
import { idempotency } from './06-idempotency'
import { lastTicket, RACERS } from './05-last-ticket'
import { loadBalancer } from './04-load-balancer'
import { redisDown } from './03-redis-down'
import { EVENT_ID } from './common'
import { runScenario } from './run'

// Each scenario runs to its "Must show" outcome with the default seed (docs/project/lab-plan.md#scenarios).

const res = (s: Sim, id: string) => s.state.requests.find((r) => r.id === id)!.response!
const body = (s: Sim, id: string) => res(s, id).body as Record<string, unknown>
const available = (s: Sim) => s.state.inventory.stock.find((x) => x.eventId === EVENT_ID)!.available

describe('01 happy path', () => {
  it('pending → reserve → outbox → payment-queue → paid → notification-queue → tickets', () => {
    const { sim, stepEvents } = runScenario(happyPath)
    const [placed, paid, notified] = stepEvents

    expect(placed.some((e) => e.kind === 'response' && e.to === 'browser' && e.status === 202)).toBe(true)
    expect(placed.some((e) => e.label.includes('INSERT outbox (OrderCreated)'))).toBe(true)
    expect(paid.some((e) => e.kind === 'publish' && e.label.includes('OrderCreated → payment-queue'))).toBe(true)
    expect(paid.some((e) => e.label.includes("status = 'paid'"))).toBe(true)
    expect(notified.some((e) => e.kind === 'publish' && e.label.includes('PaymentSucceeded → notification-queue'))).toBe(true)

    expect(res(sim, 'order').status).toBe(202)
    expect(sim.state.orders.orders[0].status).toBe('paid')
    expect(sim.state.orders.tickets.map((t) => t.number).sort()).toEqual([1, 2])
    expect(sim.state.orders.outbox.every((r) => r.publishedAt !== null)).toBe(true)
    expect(available(sim)).toBe(8)
  })
})

describe('02 cache', () => {
  it('MISS → HIT → DEL + INCR catalog:version → MISS, then the jittered TTL expires', () => {
    const { sim, stepEvents } = runScenario(cache)
    const xcache = (id: string) => res(sim, id).headers['X-Cache']

    expect([xcache('read-1'), xcache('read-2')]).toEqual(['MISS', 'HIT'])
    expect(res(sim, 'update').status).toBe(200)
    const invalidation = stepEvents[2].filter((e) => e.kind === 'cache').map((e) => e.label)
    expect(invalidation.some((l) => l.startsWith('DEL catalog:event:'))).toBe(true)
    expect(invalidation.some((l) => l.startsWith('INCR catalog:version'))).toBe(true)
    expect(xcache('read-3')).toBe('MISS')
    expect(body(sim, 'read-3').price).toBe(30)
    expect(xcache('read-4')).toBe('MISS')

    // The TTL set on a miss is within ± jitter of the configured TTL.
    const ttl = sim.state.redis[`catalog:event:${EVENT_ID}`].expiresAt! - sim.state.now
    expect(ttl).toBeGreaterThan(config.cacheTtlMs * (1 - config.cacheJitter) - 1_000)
    expect(ttl).toBeLessThanOrEqual(config.cacheTtlMs * (1 + config.cacheJitter))
  })
})

describe('03 Redis down', () => {
  it('falls back to Postgres, always MISS, health degraded; recovers on its own', () => {
    const { sim, stepEvents } = runScenario(redisDown)

    for (const id of ['read-1', 'read-2', 'list-1']) expect([res(sim, id).status, res(sim, id).headers['X-Cache']]).toEqual([200, 'MISS'])
    expect(stepEvents[1].some((e) => e.kind === 'cache' && e.error)).toBe(true)
    expect(stepEvents[1].some((e) => e.kind === 'sql')).toBe(true)
    expect(catalogHealth({ state: { toggles: { ...sim.state.toggles, redisUp: false } } })).toBe('degraded')
    expect([res(sim, 'read-3').headers['X-Cache'], res(sim, 'read-4').headers['X-Cache']]).toEqual(['MISS', 'HIT'])
    expect(catalogHealth(sim)).toBe('healthy')
  })
})

describe('04 load balancer + rate limit', () => {
  it('round-robins per X-Upstream; a burst of 160 gives 101 × 200 and 59 × 429', () => {
    const { sim } = runScenario(loadBalancer)
    const requests = sim.state.requests

    const upstreams = requests.filter((r) => r.id.startsWith('rr-')).map((r) => r.response!.headers['X-Upstream'])
    expect(upstreams.filter((u) => u === 'catalog-1')).toHaveLength(10)
    expect(upstreams.filter((u) => u === 'catalog-2')).toHaveLength(10)
    // Concurrent reads all miss before the first SET lands (the step text says so).
    expect(new Set(requests.filter((r) => r.id.startsWith('rr-')).map((r) => r.response!.headers['X-Cache']))).toEqual(new Set(['MISS']))
    expect(res(sim, 'availability').headers['X-Upstream']).toBe('inventory')
    expect(res(sim, 'internal').status).toBe(404)

    const burst = requests.filter((r) => /^req-\d+$/.test(r.id)).map((r) => r.response!.status)
    expect(burst).toHaveLength(160)
    expect(burst.filter((c) => c === 200)).toHaveLength(config.rateLimit.burst + 1)
    expect(burst.filter((c) => c === 429)).toHaveLength(160 - config.rateLimit.burst - 1)
    expect(res(sim, 'after').status).toBe(200)
  })
})

describe('05 last-ticket race', () => {
  it('one 202, the rest 409 sold_out, stock never below 0', () => {
    const { sim } = runScenario(lastTicket)
    const statuses = Array.from({ length: RACERS }, (_, i) => res(sim, `race-${i + 1}`).status)

    expect(statuses.filter((s) => s === 202)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(RACERS - 1)
    const loser = statuses.indexOf(409) + 1
    expect(body(sim, `race-${loser}`).type).toBe('sold_out')
    expect(available(sim)).toBe(0)
    expect(sim.state.orders.orders.filter((o) => o.cancelReason === 'sold_out')).toHaveLength(RACERS - 1)
    expect(sim.state.orders.orders.filter((o) => o.status === 'paid')).toHaveLength(1)
    expect(sim.state.orders.tickets).toHaveLength(1)
  })
})

describe('06 idempotency', () => {
  it('same key ×3 → same order id, one outbox row; missing key → 400', () => {
    const { sim } = runScenario(idempotency)
    const ids = ['click-1', 'click-2', 'retry'].map((id) => body(sim, id).id)

    expect(new Set(ids).size).toBe(1)
    expect(['click-1', 'click-2', 'retry'].map((id) => res(sim, id).status)).toEqual([202, 202, 202])
    expect(sim.state.orders.orders).toHaveLength(1)
    expect(sim.state.orders.outbox.filter((r) => r.type === 'OrderCreated')).toHaveLength(1)
    expect(sim.state.inventory.reservations).toHaveLength(1)
    expect(available(sim)).toBe(8)
    expect(res(sim, 'no-key').status).toBe(400)
  })
})
