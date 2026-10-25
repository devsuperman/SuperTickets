import { ack, get, nack } from './broker'
import { config } from './config'
import { inventoryHandle } from './inventory'
import { failed, sql } from './net'
import { addToOutbox } from './outbox'
import { resilientCall } from './resilience'
import { type Proc, type Runtime, sleep } from './runtime'
import type { QueueMessage, QueueName } from './types'

// Mirrors src/Worker/Features (ProcessPayment, SendNotification) and SuperTickets.Shared/Messaging/QueueConsumer.cs.
// Handlers return false where the real ones throw: the message is nacked and redelivered.
// Worker down stops polling; a handler already running finishes (the lab does not model a crash mid-handler).

const node = 'worker' as const

type Handle = (rt: Runtime, msg: QueueMessage) => Proc<boolean>

export function startWorker(rt: Runtime) {
  rt.spawn(consumer(rt, 'payment-queue', handlePayment))
  rt.spawn(consumer(rt, 'notification-queue', handleNotification))
}

function* consumer(rt: Runtime, queue: QueueName, handle: Handle): Proc {
  for (;;) {
    if (!rt.state.toggles.workerUp) {
      yield* sleep(config.consumerIdleMs)
      continue
    }
    if (!rt.state.toggles.rabbitmqUp) {
      yield* sleep(config.consumerErrorDelayMs) // "Receiving from {Queue} failed"
      continue
    }
    let handled = 0
    for (let i = 0; i < config.consumerBatch; i++) {
      const msg = get(rt, queue, node)
      if (!msg) break
      if (!(yield* handle(rt, msg))) {
        nack(rt, queue, node, msg)
        break // a failing message is not redelivered within the same poll
      }
      ack(rt, queue, node, msg)
      handled++
    }
    if (handled === 0) yield* sleep(config.consumerIdleMs)
  }
}

interface OrderCreated { orderId: string; eventId: string; quantity: number; customerEmail: string }

/** OrderCreated → simulated payment → paid or cancelled + outbox event; on failure release stock. */
function* handlePayment(rt: Runtime, msg: QueueMessage): Proc<boolean> {
  const m = msg.payload as unknown as OrderCreated
  const cid = msg.correlationId

  let succeeded = yield* sql(rt, node, (p) => `SELECT succeeded FROM payments WHERE order_id = … → ${p === undefined ? 'no row' : `${p} (replay: reuse it)`}`,
    () => rt.state.orders.payments.find((p) => p.orderId === m.orderId)?.succeeded, cid)

  if (succeeded === undefined) {
    const ok = rt.rng.next() >= rt.state.toggles.paymentFailureRate
    const paid = yield* sql<boolean | null>(rt, node, (r) => r === null
      ? "UPDATE orders … WHERE status = 'pending' → 0 rows (not pending): payment skipped"
      : `BEGIN; UPDATE orders SET status = '${r ? 'paid' : 'cancelled'}' WHERE status = 'pending' → 1 row; INSERT payments; INSERT outbox (${r ? 'PaymentSucceeded' : 'PaymentFailed'}); COMMIT`, () => {
      const o = rt.state.orders.orders.find((x) => x.id === m.orderId && x.status === 'pending')
      if (!o) return null
      Object.assign(o, { status: ok ? 'paid' : 'cancelled', cancelReason: ok ? null : 'payment_failed', updatedAt: rt.now })
      rt.state.orders.payments.push({ orderId: m.orderId, succeeded: ok, processedAt: rt.now })
      if (ok) addToOutbox(rt, 'PaymentSucceeded', { ...pick(m), paidAt: rt.now }, cid)
      else addToOutbox(rt, 'PaymentFailed', { orderId: m.orderId, eventId: m.eventId, quantity: m.quantity, reason: 'simulated_decline', failedAt: rt.now }, cid)
      return ok
    }, cid)
    if (paid === null) return true
    succeeded = paid
  }

  if (!succeeded) {
    // Compensation. A release error leaves the message for redelivery; release is idempotent.
    const r = yield* resilientCall(rt, node, 'inventory',
      { method: 'DELETE', path: `/inventory/reservations/${m.orderId}`, headers: { 'X-Correlation-Id': cid } },
      inventoryHandle, config.workerReleaseRetry, { correlationId: cid })
    if (failed(r)) {
      rt.emit({ from: node, to: node, kind: 'log', error: true, label: 'release failed: message stays on the queue', correlationId: cid })
      return false
    }
  }
  return true
}

const pick = ({ orderId, eventId, quantity, customerEmail }: OrderCreated) => ({ orderId, eventId, quantity, customerEmail })

/** PaymentSucceeded → tickets 1..quantity (idempotent) and a logged confirmation. */
function* handleNotification(rt: Runtime, msg: QueueMessage): Proc<boolean> {
  const m = msg.payload as unknown as OrderCreated
  const cid = msg.correlationId
  if (rt.rng.next() < rt.state.toggles.notificationErrorRate) {
    rt.emit({ from: node, to: node, kind: 'log', error: true, label: 'demo toggle: simulated notification error', correlationId: cid })
    return false
  }

  yield* sql(rt, node, (n) => `INSERT tickets 1..${m.quantity} ON CONFLICT (order_id, number) DO NOTHING → ${n} rows`, () => {
    let inserted = 0
    for (let n = 1; n <= m.quantity; n++) {
      if (rt.state.orders.tickets.some((t) => t.orderId === m.orderId && t.number === n)) continue
      rt.state.orders.tickets.push({
        id: rt.rng.uuid(), orderId: m.orderId, number: n, eventId: m.eventId,
        customerEmail: m.customerEmail, status: 'valid', createdAt: rt.now,
      })
      inserted++
    }
    return inserted
  }, cid)
  rt.emit({ from: node, to: node, kind: 'log', label: `confirmation sent to ${m.customerEmail}: ${m.quantity} ticket(s)`, correlationId: cid })
  return true
}
