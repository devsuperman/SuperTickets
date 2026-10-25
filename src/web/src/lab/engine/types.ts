// Public types of the lab simulation engine (docs/project/lab-plan.md#simulation-engine).
// Rows use the column names of docs/project/contracts.md#databases (camelCased); times are virtual ms.

export type NodeId =
  | 'browser' | 'gateway' | 'web' | 'catalog-1' | 'catalog-2' | 'redis' | 'inventory'
  | 'order' | 'rabbitmq' | 'worker' | 'postgres'

export type SimEventKind =
  | 'http' | 'response' | 'sql' | 'cache' | 'publish' | 'deliver' | 'ack' | 'nack' | 'dlq'
  | 'retry' | 'breaker' | 'timer' | 'log'

/** One arrow in the diagram, one line in the log. */
export interface SimEvent {
  t: number
  from: NodeId
  to: NodeId
  kind: SimEventKind
  label: string
  correlationId?: string
  status?: number
  /** Something went wrong on this hop (timeout, refused, 5xx, failed handler). */
  error?: boolean
  /** Key into the scenario's explanation text. */
  explain?: string
}

export interface Toggles {
  /** Worker `Payment__FailureRate`. */
  paymentFailureRate: number
  /** Inventory `Demo__DelayMs` (reserve only). */
  inventoryDelayMs: number
  /** Inventory `Demo__ErrorRate` (reserve only). */
  inventoryErrorRate: number
  /** Worker `Demo__NotificationErrorRate`. */
  notificationErrorRate: number
  redisUp: boolean
  rabbitmqUp: boolean
  workerUp: boolean
  inventoryUp: boolean
}

export type Headers = Record<string, string>

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path with optional query string, e.g. `/events?search=rock`. */
  path: string
  headers?: Headers
  body?: unknown
}

export interface HttpResponse {
  status: number
  headers: Headers
  body?: unknown
}

export type Action =
  | ({ type: 'request'; requestId?: string } & HttpRequest)
  | { type: 'burst'; count: number; path: string }
  | { type: 'setToggle'; key: keyof Toggles; value: number | boolean }
  /** Publish an outbox row again (the publisher crashed after publish, before commit): a duplicate delivery. */
  | { type: 'redeliver'; messageId: string }

/** A request sent by the browser, as the network tab would show it. */
export interface BrowserRequest {
  id: string
  method: HttpRequest['method']
  path: string
  sentAt: number
  doneAt: number | null
  response: HttpResponse | null
}

export interface CatalogEventRow {
  id: string
  name: string
  venue: string
  startsAt: number
  totalTickets: number
  price: number
  createdAt: number
  updatedAt: number
}

export interface CacheEntry {
  value: unknown
  /** Null = no TTL (`catalog:version`). */
  expiresAt: number | null
}

export interface StockRow { eventId: string; totalTickets: number; available: number }

export interface ReservationRow {
  orderId: string
  eventId: string
  quantity: number
  status: 'active' | 'released'
  createdAt: number
  releasedAt: number | null
}

export type OrderStatus = 'pending' | 'paid' | 'cancelled'
export type CancelReason = 'sold_out' | 'payment_failed' | 'expired'

export interface OrderRow {
  id: string
  eventId: string
  quantity: number
  customerEmail: string
  status: OrderStatus
  cancelReason: CancelReason | null
  idempotencyKey: string
  createdAt: number
  updatedAt: number
}

export interface PaymentRow { orderId: string; succeeded: boolean; processedAt: number }

export interface TicketRow {
  id: string
  orderId: string
  number: number
  eventId: string
  customerEmail: string
  status: 'valid' | 'used' | 'cancelled'
  createdAt: number
}

export type MessageType = 'OrderCreated' | 'PaymentSucceeded' | 'PaymentFailed'

export interface OutboxRow {
  id: string
  type: MessageType
  payload: Record<string, unknown>
  correlationId: string
  createdAt: number
  publishedAt: number | null
}

export type QueueName = 'payment-queue' | 'notification-queue' | 'payment-dlq' | 'notification-dlq'

export interface QueueMessage {
  /** Outbox row id. */
  messageId: string
  type: MessageType
  payload: Record<string, unknown>
  correlationId: string
  /** Deliveries so far; dead-lettered when a failed delivery reaches `maxDeliveries`. */
  deliveryCount: number
  /** Delivered and not yet acked or nacked. */
  unacked: boolean
}

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerSnapshot {
  state: BreakerState
  /** Outcomes inside the sampling window (true = success). */
  samples: { t: number; ok: boolean }[]
  openedAt: number | null
}

export interface SimState {
  now: number
  toggles: Toggles
  catalog: { events: CatalogEventRow[] }
  redis: Record<string, CacheEntry>
  inventory: { stock: StockRow[]; reservations: ReservationRow[] }
  orders: { orders: OrderRow[]; payments: PaymentRow[]; tickets: TicketRow[]; outbox: OutboxRow[] }
  broker: { queues: Record<QueueName, QueueMessage[]> }
  /** Order → Inventory reserve circuit breaker. */
  breaker: BreakerSnapshot
  /** nginx `limit_req` state for the single browser client. */
  gateway: { excess: number | null; lastAt: number; nextCatalog: 0 | 1 }
  requests: BrowserRequest[]
}

export interface Sim {
  /** Deep copy for the inspector. */
  readonly state: SimState
  dispatch(action: Action): void
  /** Run the virtual clock forward; returns what happened. */
  advance(ms: number): SimEvent[]
  reset(seed: number): void
}

/** An event that exists before the scenario starts (already in Catalog and Inventory). */
export interface SeedEvent {
  id?: string
  name: string
  venue: string
  /** Virtual ms; default 30 days after start. */
  startsAt?: number
  totalTickets: number
  price: number
}

export interface SimOptions {
  seed?: number
  toggles?: Partial<Toggles>
  events?: SeedEvent[]
}
