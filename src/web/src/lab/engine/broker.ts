import { config } from './config'
import type { Runtime } from './runtime'
import type { MessageType, NodeId, OutboxRow, QueueMessage, QueueName } from './types'

// Mirrors docs/project/contracts.md#messages and SuperTickets.Shared/Messaging/RabbitMq.cs:
// topic exchange `supertickets-events` (routing key = event type), durable quorum queues,
// manual ack, nack + requeue on failure, dead-lettered once a message has been delivered maxDeliveries times.

export const bindings: Partial<Record<MessageType, QueueName>> = {
  OrderCreated: 'payment-queue',
  PaymentSucceeded: 'notification-queue',
  // PaymentFailed: no subscriber (observability only).
}

export const dlqOf = (q: QueueName) => q.replace('-queue', '-dlq') as QueueName

export const emptyQueues = (): Record<QueueName, QueueMessage[]> =>
  ({ 'payment-queue': [], 'notification-queue': [], 'payment-dlq': [], 'notification-dlq': [] })

/** Exchange routing. Returns the queue, or null when no queue is bound (the message is dropped). */
export function publish(rt: Runtime, from: NodeId, row: OutboxRow): QueueName | null {
  const queue = bindings[row.type] ?? null
  rt.emit({
    from, to: 'rabbitmq', kind: 'publish', correlationId: row.correlationId,
    label: `publish ${row.type} → ${queue ?? 'no queue bound (dropped)'}`,
  })
  if (queue) {
    rt.state.broker.queues[queue].push({
      messageId: row.id, type: row.type, payload: structuredClone(row.payload),
      correlationId: row.correlationId, deliveryCount: 0, unacked: false,
    })
  }
  return queue
}

/** basic.get: the first message not already delivered to a consumer. */
export function get(rt: Runtime, queue: QueueName, to: NodeId): QueueMessage | null {
  const msg = rt.state.broker.queues[queue].find((m) => !m.unacked)
  if (!msg) return null
  msg.deliveryCount++
  msg.unacked = true
  rt.emit({
    from: 'rabbitmq', to, kind: 'deliver', correlationId: msg.correlationId,
    label: `deliver ${msg.type} from ${queue} (delivery ${msg.deliveryCount}/${config.maxDeliveries})`,
  })
  return msg
}

export function ack(rt: Runtime, queue: QueueName, from: NodeId, msg: QueueMessage) {
  const q = rt.state.broker.queues[queue]
  q.splice(q.indexOf(msg), 1)
  rt.emit({ from, to: 'rabbitmq', kind: 'ack', label: `ack ${msg.type}`, correlationId: msg.correlationId })
}

/** nack + requeue; the quorum `x-delivery-limit` dead-letters it after the last allowed delivery. */
export function nack(rt: Runtime, queue: QueueName, from: NodeId, msg: QueueMessage) {
  rt.emit({ from, to: 'rabbitmq', kind: 'nack', error: true, label: `nack ${msg.type} (requeue)`, correlationId: msg.correlationId })
  msg.unacked = false
  if (msg.deliveryCount < config.maxDeliveries) return
  const q = rt.state.broker.queues[queue]
  q.splice(q.indexOf(msg), 1)
  rt.state.broker.queues[dlqOf(queue)].push(msg)
  rt.emit({
    from: 'rabbitmq', to: 'rabbitmq', kind: 'dlq', error: true, correlationId: msg.correlationId,
    label: `${msg.type} dead-lettered to ${dlqOf(queue)} after ${msg.deliveryCount} deliveries`,
  })
}
