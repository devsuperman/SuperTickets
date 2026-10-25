import type { Toggles } from './types'

// Every number the real system uses, with where it comes from. Change them together with the code.
export const config = {
  /** docker-compose.yml `Admin__ApiKey`. */
  adminApiKey: 'dev-admin-key',

  /** Catalog `Cache__TtlSeconds` ± 10 % (Common/EventCache.cs). */
  cacheTtlMs: 60_000,
  cacheJitter: 0.1,

  /** infra/nginx/nginx.conf `limit_req`: 50 r/s, burst 100, nodelay. */
  rateLimit: { perSecond: 50, burst: 100 },

  /** Order.Api/Program.cs "inventory-reserve": retry → breaker → per-attempt timeout. */
  reserveRetry: { retries: 2, baseDelayMs: 200, timeoutMs: 2_000 },
  breaker: { failureRatio: 0.5, minimumThroughput: 5, samplingMs: 30_000, breakMs: 15_000 },
  /** Order.Api/Program.cs "inventory-release". */
  orderReleaseRetry: { retries: 2, baseDelayMs: 200, timeoutMs: 2_000 },
  /** Worker/WorkerServices.cs "inventory". */
  workerReleaseRetry: { retries: 3, baseDelayMs: 200, timeoutMs: 2_000 },
  /** Catalog.Api/Program.cs "inventory". */
  catalogInventoryRetry: { retries: 2, baseDelayMs: 200, timeoutMs: 2_000 },

  /** Order `Orders__SweepIntervalSeconds` / `Orders__PendingTimeoutMinutes`. */
  sweepIntervalMs: 30_000,
  pendingTimeoutMs: 5 * 60_000,

  /** SuperTickets.Shared/Messaging/OutboxPublisher.cs. */
  outboxPollMs: 1_000,
  outboxBatch: 50,

  /** SuperTickets.Shared/Messaging/QueueConsumer.cs. */
  consumerIdleMs: 250,
  consumerErrorDelayMs: 2_000,
  consumerBatch: 10,
  /** `Messaging__MaxDeliveries`: dead-lettered after this many deliveries. */
  maxDeliveries: 5,

  /** Illustrative only (the real values depend on the machine); small so the clock stays readable. */
  latency: { netMs: 2, sqlMs: 3, redisMs: 1 },
} as const

/** docker-compose.yml defaults. */
export const defaultToggles: Toggles = {
  paymentFailureRate: 0.1,
  inventoryDelayMs: 0,
  inventoryErrorRate: 0,
  notificationErrorRate: 0,
  redisUp: true,
  rabbitmqUp: true,
  workerUp: true,
  inventoryUp: true,
}
