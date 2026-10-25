import { config } from './config'
import { inventoryHandle } from './inventory'
import { type CallResult, correlationOf, json, problem, redis, splitPath, sql } from './net'
import { resilientCall } from './resilience'
import type { Proc, Runtime } from './runtime'
import type { CatalogEventRow, HttpRequest, HttpResponse, NodeId } from './types'

// Mirrors src/Catalog.Api/Features and Common/EventCache.cs (docs/project/contracts.md#cache-catalog).
// Cache-aside: every Redis failure is treated as a miss, so Catalog keeps working without Redis.

type CatalogNode = Extract<NodeId, 'catalog-1' | 'catalog-2'>
type EventDto = Omit<CatalogEventRow, 'createdAt' | 'updatedAt'>
type EventInput = Omit<EventDto, 'id'>

const VERSION_KEY = 'catalog:version'
export const eventKey = (id: string) => `catalog:event:${id}`

/** Catalog `/health`: Redis down is degraded, not unhealthy, so the replica stays in rotation. */
export const catalogHealth = (rt: { state: { toggles: { redisUp: boolean } } }) =>
  rt.state.toggles.redisUp ? 'healthy' : 'degraded'

export function* catalogHandle(rt: Runtime, node: CatalogNode, req: HttpRequest): Proc<HttpResponse> {
  const cid = correlationOf(rt, req)
  const { pathname, query } = splitPath(req.path)
  let m: RegExpMatchArray | null
  let res: HttpResponse
  if (req.method === 'GET' && pathname === '/events') res = yield* listEvents(rt, node, query.get('search') ?? '', cid)
  else if (req.method === 'GET' && (m = pathname.match(/^\/events\/([^/]+)$/))) res = yield* getEvent(rt, node, m[1], cid)
  else if (pathname.startsWith('/admin/') && req.headers?.['X-Api-Key'] !== config.adminApiKey) res = problem(401, 'Unauthorized')
  else if (req.method === 'POST' && pathname === '/admin/events') res = yield* createEvent(rt, node, req.body as EventInput, cid)
  else if (req.method === 'PUT' && (m = pathname.match(/^\/admin\/events\/([^/]+)$/))) res = yield* updateEvent(rt, node, m[1], req.body as EventInput, cid)
  else res = problem(404, 'Not found')
  res.headers['X-Correlation-Id'] = cid
  return res
}

const toDto = ({ id, name, venue, startsAt, totalTickets, price }: CatalogEventRow): EventDto =>
  ({ id, name, venue, startsAt, totalTickets, price })

// --- cache (EventCache.cs) ---

function* cacheGet(rt: Runtime, node: CatalogNode, key: string, cid: string): Proc<unknown> {
  const r = yield* redis(rt, node, `GET ${key}`, () => {
    const e = rt.state.redis[key]
    if (e && e.expiresAt !== null && e.expiresAt <= rt.now) delete rt.state.redis[key]
    return rt.state.redis[key]?.value
  }, cid, (v) => (v === undefined ? 'nil' : 'hit'))
  return r.ok ? r.value : undefined
}

function* cacheSet(rt: Runtime, node: CatalogNode, key: string, value: unknown, cid: string): Proc {
  const ttl = Math.round(config.cacheTtlMs * (1 - config.cacheJitter + rt.rng.next() * 2 * config.cacheJitter))
  yield* redis(rt, node, `SET ${key} EX ${(ttl / 1000).toFixed(1)}s`, () => {
    rt.state.redis[key] = { value: structuredClone(value), expiresAt: rt.now + ttl }
  }, cid)
}

/** Null when Redis is down: the list is then neither read from nor written to the cache. */
function* listKey(rt: Runtime, node: CatalogNode, search: string, cid: string): Proc<string | null> {
  const r = yield* redis(rt, node, `GET ${VERSION_KEY}`, () => Number(rt.state.redis[VERSION_KEY]?.value ?? 0), cid, String)
  return r.ok ? `catalog:v${r.value}:events:${search.toLowerCase()}` : null
}

/** Admin write: drop the event key and bump the list version (one try; a failure is only logged). */
function* invalidate(rt: Runtime, node: CatalogNode, id: string, cid: string): Proc {
  const del = yield* redis(rt, node, `DEL ${eventKey(id)}`, () => { delete rt.state.redis[eventKey(id)] }, cid)
  if (!del.ok) {
    rt.emit({ from: node, to: node, kind: 'log', label: 'Redis unavailable, cache not invalidated (stale until TTL)', error: true, correlationId: cid })
    return
  }
  yield* redis(rt, node, `INCR ${VERSION_KEY}`, () => {
    const v = Number(rt.state.redis[VERSION_KEY]?.value ?? 0) + 1
    rt.state.redis[VERSION_KEY] = { value: v, expiresAt: null }
    return v
  }, cid, String)
}

// --- features ---

function* listEvents(rt: Runtime, node: CatalogNode, rawSearch: string, cid: string): Proc<HttpResponse> {
  const search = rawSearch.trim()
  if (search.length > 100) return problem(400, 'Validation failed', undefined, { search: ['Search must be at most 100 characters.'] })

  const key = yield* listKey(rt, node, search, cid)
  const hit = key ? yield* cacheGet(rt, node, key, cid) : undefined
  if (hit !== undefined) return json(200, hit, { 'X-Cache': 'HIT' })

  const s = search.toLowerCase()
  const events = yield* sql(rt, node, (rows) => `SELECT * FROM events WHERE starts_at > now()${s ? ` AND (name ILIKE '%${s}%' OR venue ILIKE …)` : ''} ORDER BY starts_at LIMIT 100 → ${rows.length} rows`,
    () => rt.state.catalog.events
      .filter((e) => e.startsAt > rt.now && (!s || e.name.toLowerCase().includes(s) || e.venue.toLowerCase().includes(s)))
      .sort((a, b) => a.startsAt - b.startsAt).slice(0, 100).map(toDto), cid)

  const setKey = yield* listKey(rt, node, search, cid)
  if (setKey) yield* cacheSet(rt, node, setKey, events, cid)
  return json(200, events, { 'X-Cache': 'MISS' })
}

function* getEvent(rt: Runtime, node: CatalogNode, id: string, cid: string): Proc<HttpResponse> {
  const hit = yield* cacheGet(rt, node, eventKey(id), cid)
  if (hit !== undefined) return json(200, hit, { 'X-Cache': 'HIT' })

  const row = yield* sql(rt, node, (r) => `SELECT * FROM events WHERE id = … → ${r ? 1 : 0} rows`,
    () => rt.state.catalog.events.find((e) => e.id === id), cid)
  if (!row) return { ...problem(404, 'Event not found'), headers: { 'X-Cache': 'MISS' } }
  const dto = toDto(row)
  yield* cacheSet(rt, node, eventKey(id), dto, cid)
  return json(200, dto, { 'X-Cache': 'MISS' })
}

function validate(rt: Runtime, input: Partial<EventInput> | undefined) {
  const errors: Record<string, string[]> = {}
  const text = (v: unknown) => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 200
  if (!text(input?.name)) errors.name = ['name is required (1-200 chars).']
  if (!text(input?.venue)) errors.venue = ['venue is required (1-200 chars).']
  if (!(typeof input?.startsAt === 'number' && input.startsAt > rt.now)) errors.startsAt = ['startsAt must be in the future.']
  const total = input?.totalTickets
  if (!(Number.isInteger(total) && total! >= 1 && total! <= 100_000)) errors.totalTickets = ['totalTickets must be between 1 and 100000.']
  const price = input?.price
  if (!(typeof price === 'number' && price >= 0.01 && price <= 100_000 && Math.round(price * 100) === price * 100)) errors.price = ['price must be 0.01-100000 with 2 decimals.']
  return errors
}

function capacityProblem(r: CallResult): HttpResponse | null {
  if ('response' in r && r.response.status < 300) return null
  if ('response' in r && r.response.status === 409) return problem(409, 'Capacity below reserved tickets', 'capacity_below_sold')
  return problem(503, 'Inventory unavailable', 'dependency_unavailable')
}

function* setCapacity(rt: Runtime, node: CatalogNode, id: string, totalTickets: number, cid: string) {
  return yield* resilientCall(rt, node, 'inventory',
    { method: 'PUT', path: `/inventory/events/${id}`, body: { totalTickets }, headers: { 'X-Correlation-Id': cid } },
    inventoryHandle, config.catalogInventoryRetry, { correlationId: cid })
}

function* createEvent(rt: Runtime, node: CatalogNode, input: EventInput, cid: string): Proc<HttpResponse> {
  const errors = validate(rt, input)
  if (Object.keys(errors).length > 0) return problem(400, 'Validation failed', undefined, errors)

  const id = rt.rng.uuid()
  const failure = capacityProblem(yield* setCapacity(rt, node, id, input.totalTickets, cid))
  if (failure) return failure

  const row: CatalogEventRow = {
    id, name: input.name.trim(), venue: input.venue.trim(), startsAt: input.startsAt,
    totalTickets: input.totalTickets, price: input.price, createdAt: rt.now, updatedAt: rt.now,
  }
  yield* sql(rt, node, `INSERT INTO events ('${row.name}')`, () => { rt.state.catalog.events.push(row) }, cid)
  yield* invalidate(rt, node, id, cid)
  return json(201, toDto(row), { Location: `/events/${id}` })
}

function* updateEvent(rt: Runtime, node: CatalogNode, id: string, input: EventInput, cid: string): Proc<HttpResponse> {
  const errors = validate(rt, input)
  if (Object.keys(errors).length > 0) return problem(400, 'Validation failed', undefined, errors)

  const existing = yield* sql(rt, node, (r) => `SELECT * FROM events WHERE id = … → ${r ? 1 : 0} rows`,
    () => rt.state.catalog.events.find((e) => e.id === id), cid)
  if (!existing) return problem(404, 'Event not found')
  if (existing.startsAt <= rt.now) return problem(409, 'The event has already started.', 'event_started')

  const failure = capacityProblem(yield* setCapacity(rt, node, id, input.totalTickets, cid))
  if (failure) return failure

  const row = yield* sql(rt, node, 'UPDATE events SET … WHERE id = …', () => {
    const e = rt.state.catalog.events.find((x) => x.id === id)!
    Object.assign(e, { name: input.name.trim(), venue: input.venue.trim(), startsAt: input.startsAt,
      totalTickets: input.totalTickets, price: input.price, updatedAt: rt.now })
    return e
  }, cid)
  yield* invalidate(rt, node, id, cid)
  return json(200, toDto(row))
}
