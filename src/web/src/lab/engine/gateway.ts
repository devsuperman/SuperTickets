import { catalogHandle } from './catalog'
import { config } from './config'
import { inventoryHandle } from './inventory'
import { type Handler, call, json, problem, splitPath } from './net'
import { orderHandle } from './order'
import { type Proc, type Runtime, sleep } from './runtime'
import type { BrowserRequest, HttpRequest, HttpResponse, NodeId } from './types'

// Mirrors infra/nginx/nginx.conf and docs/project/contracts.md#routing: the only entry point.

type Route = { target: 'catalog' | 'inventory' | 'order' | 'web' | null; limited: boolean }

export function route(path: string): Route {
  const { pathname } = splitPath(path)
  if (/^\/events\/[^/]+\/availability$/.test(pathname)) return { target: 'inventory', limited: true } // matched first
  if (pathname.startsWith('/inventory')) return { target: null, limited: false } // internal only: 404
  if (pathname.startsWith('/events') || pathname.startsWith('/admin')) return { target: 'catalog', limited: true }
  if (pathname.startsWith('/orders')) return { target: 'order', limited: true }
  return { target: 'web', limited: false }
}

/**
 * nginx `limit_req ... nodelay` (leaky bucket, per client): excess drains at `perSecond`;
 * a request that would push it over `burst` gets 429 and does not count.
 */
function rateLimitAccepts(rt: Runtime) {
  const g = rt.state.gateway
  const excess = g.excess === null ? 0
    : Math.max(g.excess - (config.rateLimit.perSecond * (rt.now - g.lastAt)) / 1000 + 1, 0)
  if (excess > config.rateLimit.burst) return false
  g.excess = excess
  g.lastAt = rt.now
  return true
}

type Upstream = Extract<NodeId, 'catalog-1' | 'catalog-2' | 'inventory' | 'order'>

const handlers: Record<Upstream, Handler> = {
  'catalog-1': (rt, req) => catalogHandle(rt, 'catalog-1', req),
  'catalog-2': (rt, req) => catalogHandle(rt, 'catalog-2', req),
  inventory: inventoryHandle,
  order: orderHandle,
}

/** A browser request end to end; records it in `state.requests`. */
export function* browserRequest(rt: Runtime, id: string, req: HttpRequest): Proc {
  const record: BrowserRequest = { id, method: req.method, path: req.path, sentAt: rt.now, doneAt: null, response: null }
  rt.state.requests.push(record)
  const label = `${req.method} ${req.path}`
  const cid = req.headers?.['X-Correlation-Id']
  rt.emit({ from: 'browser', to: 'gateway', kind: 'http', label, correlationId: cid })
  yield* sleep(config.latency.netMs)

  const r = route(req.path)
  let res: HttpResponse
  if (r.limited && !rateLimitAccepts(rt)) {
    rt.emit({ from: 'gateway', to: 'gateway', kind: 'log', error: true, label: `limit_req: over ${config.rateLimit.perSecond} r/s + burst ${config.rateLimit.burst} → 429` })
    res = problem(429, 'Too Many Requests')
  } else if (r.target === null) {
    res = problem(404, 'Not Found')
  } else if (r.target === 'web') {
    res = json(200, 'SPA index.html', { 'X-Upstream': 'web' })
  } else {
    const g = rt.state.gateway
    let target: Upstream
    if (r.target === 'catalog') {
      target = g.nextCatalog === 0 ? 'catalog-1' : 'catalog-2' // round-robin
      g.nextCatalog = g.nextCatalog === 0 ? 1 : 0
    } else target = r.target
    const result = yield* call(rt, 'gateway', target, req, handlers[target], undefined, cid)
    res = 'response' in result ? result.response : problem(502, 'Bad Gateway')
    res.headers['X-Upstream'] = target
  }

  yield* sleep(config.latency.netMs)
  rt.emit({
    from: 'gateway', to: 'browser', kind: 'response', status: res.status, error: res.status >= 500 || res.status === 429,
    label: `${label} → ${res.status}${res.headers['X-Cache'] ? ` (X-Cache: ${res.headers['X-Cache']})` : ''}`,
    correlationId: res.headers['X-Correlation-Id'] ?? cid,
  })
  record.doneAt = rt.now
  record.response = res
}
