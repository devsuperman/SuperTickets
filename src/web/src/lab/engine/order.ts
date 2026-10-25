import { config } from './config'
import { inventoryHandle } from './inventory'
import { correlationOf, json, problem, splitPath, sql } from './net'
import { addToOutbox } from './outbox'
import { resilientCall } from './resilience'
import { type Proc, type Runtime, sleep } from './runtime'
import type { HttpRequest, HttpResponse, OrderRow } from './types'

// Mirrors src/Order.Api/Features (CreateOrder, GetOrder, ExpirePending) and docs/project/contracts.md#flows.
// Status updates always add `AND status = 'pending'`, so late or duplicate steps do nothing.

const node = 'order' as const

export function* orderHandle(rt: Runtime, req: HttpRequest): Proc<HttpResponse> {
  const cid = correlationOf(rt, req)
  const { pathname } = splitPath(req.path)
  let m: RegExpMatchArray | null
  let res: HttpResponse
  if (req.method === 'POST' && pathname === '/orders') res = yield* createOrder(rt, req, cid)
  else if (req.method === 'GET' && (m = pathname.match(/^\/orders\/([^/]+)$/))) res = yield* getOrder(rt, m[1], cid)
  else res = problem(404, 'Not found')
  res.headers['X-Correlation-Id'] = cid
  return res
}

function toDto(rt: Runtime, o: OrderRow) {
  const { id, eventId, quantity, customerEmail, status, cancelReason, createdAt } = o
  const tickets = rt.state.orders.tickets.filter((t) => t.orderId === id)
    .sort((a, b) => a.number - b.number).map(({ id, number, status }) => ({ id, number, status }))
  return { id, eventId, quantity, customerEmail, status, cancelReason, createdAt, tickets }
}

const hasOrderCreated = (rt: Runtime, orderId: string) =>
  rt.state.orders.outbox.some((r) => r.type === 'OrderCreated' && r.payload.orderId === orderId)

const findOrder = (rt: Runtime, id: string) => rt.state.orders.orders.find((o) => o.id === id)

interface CreateOrderBody { eventId?: string; quantity?: number; customerEmail?: string }

function validate(key: string | undefined, body: CreateOrderBody | undefined) {
  const errors: Record<string, string[]> = {}
  if (!key || key.length > 100) errors.idempotencyKey = ['Idempotency-Key header is required (1-100 chars).']
  if (!body) return { ...errors, body: ['Request body is required.'] }
  if (!body.eventId) errors.eventId = ['eventId is required.']
  if (!(Number.isInteger(body.quantity) && body.quantity! >= 1 && body.quantity! <= 10)) errors.quantity = ['quantity must be between 1 and 10.']
  const email = body.customerEmail?.trim()
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) errors.customerEmail = ['customerEmail must be a valid email (max 254 chars).']
  return errors
}

function* createOrder(rt: Runtime, req: HttpRequest, cid: string): Proc<HttpResponse> {
  const key = req.headers?.['Idempotency-Key']
  const body = req.body as CreateOrderBody | undefined
  const errors = validate(key, body)
  if (Object.keys(errors).length > 0) return problem(400, 'Validation failed', undefined, errors)

  // 1-2. Find the order for this key, or insert a pending one.
  const { order, inserted } = yield* sql(rt, node,
    (r) => r.inserted ? `SELECT … WHERE idempotency_key = '${key}' → 0 rows; INSERT orders (pending)` : `SELECT … WHERE idempotency_key = '${key}' → existing order (${r.order.status})`,
    () => {
      const existing = rt.state.orders.orders.find((o) => o.idempotencyKey === key)
      if (existing) return { order: existing, inserted: false }
      const o: OrderRow = {
        id: rt.rng.uuid(), eventId: body!.eventId!, quantity: body!.quantity!, customerEmail: body!.customerEmail!.trim(),
        status: 'pending', cancelReason: null, idempotencyKey: key!, createdAt: rt.now, updatedAt: rt.now,
      }
      rt.state.orders.orders.push(o)
      return { order: o, inserted: true }
    }, cid)

  if (!inserted && (order.status !== 'pending' || hasOrderCreated(rt, order.id))) {
    rt.emit({ from: node, to: node, kind: 'log', label: 'same Idempotency-Key: returning the existing order', correlationId: cid })
    return json(202, toDto(rt, order), { Location: `/orders/${order.id}` })
  }

  // 3. Reserve (timeout, retry, breaker). Replays resume here; reserve is idempotent by orderId.
  const r = yield* resilientCall(rt, node, 'inventory',
    { method: 'POST', path: '/inventory/reservations', body: { orderId: order.id, eventId: order.eventId, quantity: order.quantity }, headers: { 'X-Correlation-Id': cid } },
    inventoryHandle, config.reserveRetry, { breaker: true, correlationId: cid })
  const status = 'response' in r ? r.response.status : null

  if (status !== null && status < 300) {
    // 4. Outbox row and the pending check commit together.
    yield* sql(rt, node, (added) => added
      ? "BEGIN; UPDATE orders … WHERE status = 'pending' → 1 row; INSERT outbox (OrderCreated); COMMIT"
      : "BEGIN; UPDATE orders … WHERE status = 'pending' → 0 rows or OrderCreated exists; COMMIT", () => {
      const o = findOrder(rt, order.id)!
      if (o.status !== 'pending' || hasOrderCreated(rt, o.id)) return false
      o.updatedAt = rt.now
      addToOutbox(rt, 'OrderCreated', { orderId: o.id, eventId: o.eventId, quantity: o.quantity, customerEmail: o.customerEmail, createdAt: o.createdAt }, cid)
      return true
    }, cid)
    return json(202, toDto(rt, findOrder(rt, order.id)!), { Location: `/orders/${order.id}` })
  }
  if (status === 409) {
    // 5.
    yield* sql(rt, node, "UPDATE orders SET status = 'cancelled', cancel_reason = 'sold_out' WHERE status = 'pending'", () => {
      const o = findOrder(rt, order.id)!
      if (o.status === 'pending') Object.assign(o, { status: 'cancelled', cancelReason: 'sold_out', updatedAt: rt.now })
    }, cid)
    return problem(409, 'Not enough tickets available', 'sold_out')
  }
  if (status === 404) {
    yield* sql(rt, node, "DELETE FROM orders WHERE id = … AND status = 'pending'", () => {
      const list = rt.state.orders.orders
      const i = list.findIndex((o) => o.id === order.id && o.status === 'pending')
      if (i >= 0) list.splice(i, 1)
    }, cid)
    return problem(404, 'Event not found.')
  }
  // 6. Stays pending: a same-key retry resumes, otherwise the sweeper cleans up.
  return problem(503, 'Inventory unavailable', 'dependency_unavailable')
}

function* getOrder(rt: Runtime, id: string, cid: string): Proc<HttpResponse> {
  const o = yield* sql(rt, node, (r) => `SELECT orders + tickets WHERE id = … → ${r ? r.status : 'no row'}`, () => findOrder(rt, id), cid)
  return o ? json(200, toDto(rt, o)) : problem(404, 'Order not found.')
}

/** Expires stale pending orders: release stock first, then cancel (a failed release waits for the next pass). */
export function* sweeper(rt: Runtime): Proc {
  for (;;) {
    yield* sleep(config.sweepIntervalMs)
    const cutoff = rt.now - config.pendingTimeoutMs
    const stale = rt.state.orders.orders.filter((o) => o.status === 'pending' && o.createdAt < cutoff)
      .sort((a, b) => a.createdAt - b.createdAt).slice(0, 100).map((o) => o.id)
    if (stale.length === 0) continue // nothing to show for an empty pass

    yield* sql(rt, node, `sweeper: SELECT id FROM orders WHERE status = 'pending' AND created_at < now() - ${config.pendingTimeoutMs / 60_000} min → ${stale.length} rows`, () => stale)
    for (const id of stale) {
      const cid = rt.state.orders.outbox.find((r) => r.payload.orderId === id)?.correlationId
      const r = yield* resilientCall(rt, node, 'inventory', { method: 'DELETE', path: `/inventory/reservations/${id}`, headers: cid ? { 'X-Correlation-Id': cid } : {} },
        inventoryHandle, config.orderReleaseRetry, { correlationId: cid })
      if (!('response' in r) || r.response.status >= 300) continue
      yield* sql(rt, node, "UPDATE orders SET status = 'cancelled', cancel_reason = 'expired' WHERE status = 'pending'", () => {
        const o = findOrder(rt, id)!
        if (o.status === 'pending') Object.assign(o, { status: 'cancelled', cancelReason: 'expired', updatedAt: rt.now })
      }, cid)
    }
  }
}
