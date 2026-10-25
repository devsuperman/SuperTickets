import { publish } from './broker'
import { config } from './config'
import { sql } from './net'
import { type Proc, type Runtime, sleep } from './runtime'
import type { MessageType, OutboxRow } from './types'

// Mirrors SuperTickets.Shared/Messaging (outbox add helper + OutboxPublisher, hosted by Order.Api).
// Events are rows written in the same transaction as the state change; the publisher ships them later.

/** Call inside the run() of the sql() step that changes state, so both commit together. */
export function addToOutbox(rt: Runtime, type: MessageType, payload: Record<string, unknown>, correlationId: string) {
  const row: OutboxRow = { id: rt.rng.uuid(), type, payload, correlationId, createdAt: rt.now, publishedAt: null }
  rt.state.orders.outbox.push(row)
  return row
}

const unpublished = (rt: Runtime) =>
  rt.state.orders.outbox.filter((r) => r.publishedAt === null)
    .sort((a, b) => a.createdAt - b.createdAt).slice(0, config.outboxBatch)

/** Polls unpublished rows; a broker outage only delays them, nothing is lost. */
export function* outboxPublisher(rt: Runtime): Proc {
  for (;;) {
    let published = 0
    if (unpublished(rt).length > 0) {
      if (!rt.state.toggles.rabbitmqUp) {
        rt.emit({
          from: 'order', to: 'rabbitmq', kind: 'publish', error: true,
          label: `outbox publish failed: RabbitMQ unavailable; ${unpublished(rt).length} row(s) wait in the outbox`,
        })
      } else {
        const rows = yield* sql(rt, 'order', (r) => `SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT ${config.outboxBatch} FOR UPDATE SKIP LOCKED → ${r.length} rows`,
          () => unpublished(rt))
        for (const row of rows) publish(rt, 'order', row)
        yield* sql(rt, 'order', `UPDATE outbox SET published_at = now() (${rows.length} rows); COMMIT`, () => {
          for (const row of rows) row.publishedAt = rt.now
        })
        published = rows.length
      }
    }
    if (published < config.outboxBatch) yield* sleep(config.outboxPollMs)
  }
}
