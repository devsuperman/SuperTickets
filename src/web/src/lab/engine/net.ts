import { config } from './config'
import { type Proc, type Runtime, sleep, wait } from './runtime'
import type { HttpRequest, HttpResponse, NodeId } from './types'

// Hops between nodes: HTTP calls, SQL statements, Redis commands.

export type Handler = (rt: Runtime, req: HttpRequest) => Proc<HttpResponse>

export type CallResult =
  | { response: HttpResponse }
  | { failure: 'timeout' | 'refused' | 'broken_circuit' }

export const failed = (r: CallResult) => 'failure' in r || r.response.status >= 500

export function isUp(rt: Runtime, node: NodeId) {
  const t = rt.state.toggles
  if (node === 'inventory') return t.inventoryUp
  if (node === 'redis') return t.redisUp
  if (node === 'rabbitmq') return t.rabbitmqUp
  if (node === 'worker') return t.workerUp
  return true
}

/**
 * One HTTP request. The handler runs as its own process: when the caller times out it gives up,
 * but the handler still finishes (and its side effects stay), exactly like a real server.
 */
export function* call(
  rt: Runtime, from: NodeId, to: NodeId, req: HttpRequest, handler: Handler,
  timeoutMs?: number, correlationId?: string,
): Proc<CallResult> {
  const label = `${req.method} ${req.path}`
  rt.emit({ from, to, kind: 'http', label, correlationId })
  if (!isUp(rt, to)) {
    yield* sleep(1)
    rt.emit({ from: to, to: from, kind: 'response', label: `${label}: connection refused`, error: true, correlationId })
    return { failure: 'refused' }
  }

  let abandoned = false
  const done = rt.spawn((function* () {
    yield* sleep(config.latency.netMs)
    const res = yield* handler(rt, req)
    yield* sleep(config.latency.netMs)
    rt.emit({
      from: to, to: from, kind: 'response', status: res.status, error: res.status >= 500, correlationId,
      label: abandoned ? `${label} → ${res.status} (too late: caller already timed out)` : `${label} → ${res.status}`,
    })
    return res
  })())

  const r = yield* wait(done, timeoutMs)
  if (!r.ok) {
    abandoned = true
    rt.emit({ from, to: from, kind: 'timer', label: `${label}: timed out after ${timeoutMs} ms`, error: true, correlationId })
    return { failure: 'timeout' }
  }
  return { response: r.value }
}

/** One statement or transaction, applied atomically. `label` may describe the result (e.g. rows affected). */
export function* sql<T>(
  rt: Runtime, from: NodeId, label: string | ((v: T) => string), run: () => T, correlationId?: string,
): Proc<T> {
  const v = run()
  rt.emit({ from, to: 'postgres', kind: 'sql', label: typeof label === 'string' ? label : label(v), correlationId })
  yield* sleep(config.latency.sqlMs)
  return v
}

/** One Redis command. Redis down fails fast (Catalog uses `BacklogPolicy.FailFast`). */
export function* redis<T>(
  rt: Runtime, from: NodeId, command: string, run: () => T, correlationId?: string, result?: (v: T) => string,
): Proc<{ ok: true; value: T } | { ok: false }> {
  if (!rt.state.toggles.redisUp) {
    rt.emit({ from, to: 'redis', kind: 'cache', label: `${command}: Redis unavailable`, error: true, correlationId })
    yield* sleep(1)
    return { ok: false }
  }
  const v = run()
  rt.emit({ from, to: 'redis', kind: 'cache', label: result ? `${command} → ${result(v)}` : command, correlationId })
  yield* sleep(config.latency.redisMs)
  return { ok: true, value: v }
}

/** RFC 9457 Problem Details (docs/project/contracts.md#conventions). */
export function problem(status: number, title: string, type?: string, errors?: Record<string, string[]>): HttpResponse {
  return { status, headers: {}, body: { status, title, ...(type && { type }), ...(errors && { errors }) } }
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse =>
  ({ status, headers, body })

export function correlationOf(rt: Runtime, req: HttpRequest) {
  return req.headers?.['X-Correlation-Id'] || `corr-${rt.rng.uuid().slice(0, 8)}`
}

export function splitPath(path: string) {
  const [pathname, query = ''] = path.split('?')
  return { pathname, query: new URLSearchParams(query) }
}
