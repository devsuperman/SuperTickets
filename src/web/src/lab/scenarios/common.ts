import { config, type Action, type SeedEvent, type SimState } from '../engine'
import type { RepoLink } from './types'

// Building blocks shared by the scenario scripts.

export const REPO_URL = 'https://github.com/devsuperman/SuperTickets'
export const repoHref = (path: string) => `${REPO_URL}/blob/main/${path}`

export const EVENT_ID = '7f3c2a10-5b1e-4c3a-9d2e-1a2b3c4d5e6f'
export const DAY = 24 * 60 * 60_000
const EMAIL = 'lab@example.com'

export const labEvent = (totalTickets = 10): SeedEvent =>
  ({ id: EVENT_ID, name: 'Lab Show', venue: 'Lab Arena', startsAt: 30 * DAY, totalTickets, price: 25 })

/** `POST /orders`; a null key sends no `Idempotency-Key` header. */
export const placeOrder = (key: string | null, quantity = 1, requestId?: string): Action => ({
  type: 'request', requestId, method: 'POST', path: '/orders',
  headers: key === null ? {} : { 'Idempotency-Key': key },
  body: { eventId: EVENT_ID, quantity, customerEmail: EMAIL },
})

export const get = (path: string, requestId?: string): Action => ({ type: 'request', requestId, method: 'GET', path })

/** `PUT /admin/events/{id}`: a full replace of the lab event. */
export const adminUpdate = (changes: { price?: number; totalTickets?: number; name?: string }, requestId?: string): Action => ({
  type: 'request', requestId, method: 'PUT', path: `/admin/events/${EVENT_ID}`,
  headers: { 'X-Api-Key': config.adminApiKey },
  body: { name: 'Lab Show', venue: 'Lab Arena', startsAt: 30 * DAY, totalTickets: 10, price: 25, ...changes },
})

/** `GET /orders/{id}` for the first order in the database (scripts cannot know its generated id). */
export const getFirstOrder = (requestId?: string) => (s: SimState): Action[] =>
  s.orders.orders[0] ? [get(`/orders/${s.orders.orders[0].id}`, requestId)] : []

export const guides = {
  microservices: { label: '01 · Microservices and Vertical Slice', path: 'docs/learn/01-microservices-and-vertical-slice.md' },
  gateway: { label: '02 · API gateway and load balancer', path: 'docs/learn/02-api-gateway-and-load-balancer.md' },
  caching: { label: '03 · Caching', path: 'docs/learn/03-caching.md' },
  broker: { label: '04 · Message broker', path: 'docs/learn/04-message-broker.md' },
  outbox: { label: '05 · Transactional outbox', path: 'docs/learn/05-transactional-outbox.md' },
  idempotency: { label: '06 · Idempotency', path: 'docs/learn/06-idempotency.md' },
  saga: { label: '07 · Saga and compensation', path: 'docs/learn/07-saga-and-compensation.md' },
  concurrency: { label: '08 · Concurrency and inventory', path: 'docs/learn/08-concurrency-and-inventory.md' },
  resilience: { label: '09 · Resilience patterns', path: 'docs/learn/09-resilience-patterns.md' },
  observability: { label: '10 · Observability and testing', path: 'docs/learn/10-observability-and-testing.md' },
} satisfies Record<string, RepoLink>

const file = (path: string): RepoLink => ({ label: path.split('/').pop()!, path })

export const code = {
  nginx: file('infra/nginx/nginx.conf'),
  eventCache: file('src/Catalog.Api/Common/EventCache.cs'),
  getEvent: file('src/Catalog.Api/Features/GetEvent/GetEvent.cs'),
  listEvents: file('src/Catalog.Api/Features/ListEvents/ListEvents.cs'),
  updateEvent: file('src/Catalog.Api/Features/UpdateEvent/UpdateEvent.cs'),
  catalogProgram: file('src/Catalog.Api/Program.cs'),
  reserveStock: file('src/Inventory.Api/Features/ReserveStock/ReserveStock.cs'),
  releaseReservation: file('src/Inventory.Api/Features/ReleaseReservation/ReleaseReservation.cs'),
  createOrder: file('src/Order.Api/Features/CreateOrder/CreateOrder.cs'),
  sweeper: file('src/Order.Api/Features/ExpirePending/Sweeper.cs'),
  orderProgram: file('src/Order.Api/Program.cs'),
  outboxPublisher: file('src/SuperTickets.Shared/Messaging/OutboxPublisher.cs'),
  queueConsumer: file('src/SuperTickets.Shared/Messaging/QueueConsumer.cs'),
  paymentConsumer: file('src/Worker/Features/ProcessPayment/PaymentConsumer.cs'),
  notificationConsumer: file('src/Worker/Features/SendNotification/NotificationConsumer.cs'),
} satisfies Record<string, RepoLink>
