import { emptyQueues, publish } from './broker'
import { defaultToggles } from './config'
import { browserRequest } from './gateway'
import { sweeper } from './order'
import { outboxPublisher } from './outbox'
import { createRng } from './rng'
import { Runtime } from './runtime'
import { startWorker } from './worker'
import type { NodeId, Sim, SimOptions, SimState, Toggles } from './types'

const DAY = 24 * 60 * 60_000

function initialState(options: SimOptions): SimState {
  return {
    now: 0,
    toggles: { ...defaultToggles, ...options.toggles },
    catalog: { events: [] },
    redis: {},
    inventory: { stock: [], reservations: [] },
    orders: { orders: [], payments: [], tickets: [], outbox: [] },
    broker: { queues: emptyQueues() },
    breaker: { state: 'closed', samples: [], openedAt: null },
    gateway: { excess: null, lastAt: 0, nextCatalog: 0 },
    requests: [],
  }
}

const toggleNode: Record<keyof Toggles, NodeId> = {
  paymentFailureRate: 'worker', notificationErrorRate: 'worker', workerUp: 'worker',
  inventoryDelayMs: 'inventory', inventoryErrorRate: 'inventory', inventoryUp: 'inventory',
  redisUp: 'redis', rabbitmqUp: 'rabbitmq',
}

/** The whole system in the browser: Catalog ×2, Inventory, Order, Worker, Redis, RabbitMQ, Postgres, nginx. */
export function createSim(options: SimOptions = {}): Sim {
  let rt: Runtime
  let nextRequest = 1

  const build = (seed: number) => {
    rt = new Runtime(initialState(options), createRng(seed))
    nextRequest = 1
    for (const e of options.events ?? []) {
      const id = e.id ?? rt.rng.uuid()
      rt.state.catalog.events.push({
        id, name: e.name, venue: e.venue, startsAt: e.startsAt ?? 30 * DAY,
        totalTickets: e.totalTickets, price: e.price, createdAt: 0, updatedAt: 0,
      })
      rt.state.inventory.stock.push({ eventId: id, totalTickets: e.totalTickets, available: e.totalTickets })
    }
    rt.spawn(outboxPublisher(rt))
    rt.spawn(sweeper(rt))
    startWorker(rt)
  }
  build(options.seed ?? 1)

  return {
    get state() {
      return structuredClone(rt.state)
    },

    dispatch(action) {
      switch (action.type) {
        case 'request': {
          const { type: _, requestId, ...req } = action
          rt.spawn(browserRequest(rt, requestId ?? `req-${nextRequest++}`, structuredClone(req)))
          break
        }
        case 'burst':
          for (let i = 0; i < action.count; i++) {
            rt.spawn(browserRequest(rt, `req-${nextRequest++}`, { method: 'GET', path: action.path }))
          }
          break
        case 'setToggle': {
          ;(rt.state.toggles as unknown as Record<string, unknown>)[action.key] = action.value
          const n = toggleNode[action.key]
          rt.emit({ from: n, to: n, kind: 'log', label: `toggle ${action.key} = ${action.value}` })
          break
        }
        case 'redeliver': {
          const row = rt.state.orders.outbox.find((r) => r.id === action.messageId)
          if (!row || row.publishedAt === null || !rt.state.toggles.rabbitmqUp) {
            rt.emit({ from: 'order', to: 'rabbitmq', kind: 'log', error: true, label: 'redeliver: message not published yet or RabbitMQ down' })
            break
          }
          rt.emit({ from: 'order', to: 'order', kind: 'log', label: `publisher crashed before commit: ${row.type} is published again` })
          publish(rt, 'order', row)
          break
        }
      }
    },

    advance(ms) {
      rt.run(rt.now + ms)
      return rt.drain()
    },

    reset(seed) {
      build(seed)
    },
  }
}
