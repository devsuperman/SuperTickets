import { json, problem, splitPath, sql } from './net'
import { type Proc, type Runtime, sleep } from './runtime'
import type { HttpRequest, HttpResponse } from './types'

// Mirrors src/Inventory.Api/Features and docs/project/contracts.md#databases (Inventory SQL).
// Each sql() step is one transaction: nothing else runs between its statements.

const node = 'inventory' as const

export function* inventoryHandle(rt: Runtime, req: HttpRequest): Proc<HttpResponse> {
  const cid = req.headers?.['X-Correlation-Id']
  const { pathname } = splitPath(req.path)
  let m: RegExpMatchArray | null
  if (req.method === 'GET' && (m = pathname.match(/^\/events\/([^/]+)\/availability$/))) return yield* availability(rt, m[1], cid)
  if (req.method === 'PUT' && (m = pathname.match(/^\/inventory\/events\/([^/]+)$/))) return yield* setCapacity(rt, m[1], req.body as { totalTickets: number }, cid)
  if (req.method === 'POST' && pathname === '/inventory/reservations') return yield* reserve(rt, req.body as ReserveBody, cid)
  if (req.method === 'DELETE' && (m = pathname.match(/^\/inventory\/reservations\/([^/]+)$/))) return yield* release(rt, m[1], cid)
  return problem(404, 'Not found')
}

function* availability(rt: Runtime, eventId: string, cid?: string): Proc<HttpResponse> {
  const stock = yield* sql(rt, node, (s) => `SELECT available FROM stock WHERE event_id = … → ${s ? s.available : 'no row'}`,
    () => rt.state.inventory.stock.find((s) => s.eventId === eventId), cid)
  return stock ? json(200, { eventId, available: stock.available }) : problem(404, 'Event not found')
}

/** Upsert; refuses a cut below what is reserved or sold. */
function* setCapacity(rt: Runtime, eventId: string, body: { totalTickets: number }, cid?: string): Proc<HttpResponse> {
  const total = body.totalTickets
  if (!(total >= 1 && total <= 100_000)) return problem(400, 'Validation failed', undefined, { totalTickets: ['totalTickets must be between 1 and 100000.'] })
  const row = yield* sql(rt, node, (r) => r
    ? `UPSERT stock SET total_tickets = ${total} WHERE @new >= total - available → ${r.totalTickets}/${r.available}`
    : `UPDATE stock … WHERE ${total} >= total - available → 0 rows`, () => {
    const s = rt.state.inventory.stock.find((x) => x.eventId === eventId)
    if (!s) {
      const created = { eventId, totalTickets: total, available: total }
      rt.state.inventory.stock.push(created)
      return created
    }
    if (total < s.totalTickets - s.available) return null
    s.available += total - s.totalTickets
    s.totalTickets = total
    return s
  }, cid)
  return row
    ? json(200, { eventId, totalTickets: row.totalTickets, available: row.available })
    : problem(409, 'Capacity below reserved tickets', 'capacity_below_sold')
}

interface ReserveBody { orderId: string; eventId: string; quantity: number }

/** Idempotent by orderId; the conditional UPDATE is what prevents overselling. */
function* reserve(rt: Runtime, body: ReserveBody, cid?: string): Proc<HttpResponse> {
  const t = rt.state.toggles
  if (t.inventoryDelayMs > 0) yield* sleep(t.inventoryDelayMs)
  if (t.inventoryErrorRate > 0 && rt.rng.next() < t.inventoryErrorRate) {
    rt.emit({ from: node, to: node, kind: 'log', label: 'demo toggle: simulated inventory error → 500', error: true, correlationId: cid })
    return problem(500, 'Simulated inventory error')
  }

  type Outcome = 'created' | 'existing' | 'no_event' | 'sold_out'
  const outcome = yield* sql<Outcome>(rt, node, (o) => ({
    created: `INSERT reservations ON CONFLICT DO NOTHING → 1 row; UPDATE stock SET available = available - ${body.quantity} WHERE available >= ${body.quantity} → 1 row; COMMIT`,
    existing: 'INSERT reservations ON CONFLICT DO NOTHING → 0 rows (replay: reservation exists)',
    no_event: 'INSERT reservations … WHERE EXISTS stock → 0 rows (unknown event)',
    sold_out: `INSERT reservations → 1 row; UPDATE stock … WHERE available >= ${body.quantity} → 0 rows; ROLLBACK`,
  })[o], () => {
    const inv = rt.state.inventory
    if (inv.reservations.some((r) => r.orderId === body.orderId)) return 'existing'
    const stock = inv.stock.find((s) => s.eventId === body.eventId)
    if (!stock) return 'no_event'
    if (stock.available < body.quantity) return 'sold_out'
    stock.available -= body.quantity
    inv.reservations.push({
      orderId: body.orderId, eventId: body.eventId, quantity: body.quantity,
      status: 'active', createdAt: rt.now, releasedAt: null,
    })
    return 'created'
  }, cid)

  const reservation = () => rt.state.inventory.reservations.find((r) => r.orderId === body.orderId)
  switch (outcome) {
    case 'created': return json(201, reservation())
    case 'existing': return json(200, reservation())
    case 'no_event': return problem(404, 'Event not found')
    case 'sold_out': return problem(409, 'Not enough tickets available', 'sold_out')
  }
}

/** Idempotent: only an active reservation gives its tickets back. */
function* release(rt: Runtime, orderId: string, cid?: string): Proc<HttpResponse> {
  yield* sql(rt, node, (q) => q
    ? `UPDATE reservations SET status = 'released' WHERE status = 'active' → 1 row; UPDATE stock SET available = available + ${q}`
    : `UPDATE reservations SET status = 'released' WHERE status = 'active' → 0 rows (already released or missing)`, () => {
    const r = rt.state.inventory.reservations.find((x) => x.orderId === orderId && x.status === 'active')
    if (!r) return 0
    r.status = 'released'
    r.releasedAt = rt.now
    rt.state.inventory.stock.find((s) => s.eventId === r.eventId)!.available += r.quantity
    return r.quantity
  }, cid)
  return { status: 204, headers: {} }
}
