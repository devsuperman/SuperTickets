import { config } from './config'
import { type CallResult, type Handler, call, failed } from './net'
import { type Proc, type Runtime, sleep } from './runtime'
import type { HttpRequest, NodeId } from './types'

// Polly v8 pipelines from the services' Program.cs: retry (outermost) → circuit breaker → per-attempt timeout.

export interface RetryPolicy { retries: number; baseDelayMs: number; timeoutMs: number }

export function* resilientCall(
  rt: Runtime, from: NodeId, to: NodeId, req: HttpRequest, handler: Handler,
  policy: RetryPolicy, opts: { breaker?: boolean; correlationId?: string } = {},
): Proc<CallResult> {
  const { correlationId } = opts
  for (let attempt = 0; ; attempt++) {
    // An open circuit throws BrokenCircuitException, which the retry does not handle: fail fast.
    if (opts.breaker && !breakerAllows(rt, from, correlationId)) {
      rt.emit({
        from, to: from, kind: 'breaker', error: true, correlationId,
        label: `circuit open: ${req.method} ${req.path} rejected without calling ${to}`,
      })
      return { failure: 'broken_circuit' }
    }
    const r = yield* call(rt, from, to, req, handler, policy.timeoutMs, correlationId)
    if (opts.breaker) breakerRecord(rt, from, !failed(r), correlationId)
    if (!failed(r) || attempt === policy.retries) return r
    const delay = policy.baseDelayMs * 2 ** attempt // exponential, no jitter
    rt.emit({ from, to: from, kind: 'retry', label: `retry ${attempt + 1}/${policy.retries} in ${delay} ms`, correlationId })
    yield* sleep(delay)
  }
}

// Circuit breaker: opens when ≥ failureRatio of ≥ minimumThroughput calls in samplingMs failed;
// after breakMs one trial call is let through (half-open): success closes it, failure opens it again.

function breakerAllows(rt: Runtime, node: NodeId, correlationId?: string) {
  const b = rt.state.breaker
  if (b.state === 'closed') return true
  if (b.state === 'half-open') return false // the trial call is still running
  if (rt.now < b.openedAt! + config.breaker.breakMs) return false
  b.state = 'half-open'
  rt.emit({ from: node, to: node, kind: 'breaker', label: 'circuit half-open: letting one trial call through', correlationId })
  return true
}

function breakerRecord(rt: Runtime, node: NodeId, ok: boolean, correlationId?: string) {
  const b = rt.state.breaker
  if (b.state === 'open') return // outcome of a call started before the circuit opened
  if (b.state === 'half-open') {
    if (ok) {
      b.state = 'closed'
      b.samples = []
      b.openedAt = null
      rt.emit({ from: node, to: node, kind: 'breaker', label: 'circuit closed: trial call succeeded', correlationId })
    } else open(rt, node, 'trial call failed', correlationId)
    return
  }
  b.samples = b.samples.filter((s) => s.t > rt.now - config.breaker.samplingMs)
  b.samples.push({ t: rt.now, ok })
  const failures = b.samples.filter((s) => !s.ok).length
  if (!ok && b.samples.length >= config.breaker.minimumThroughput
      && failures / b.samples.length >= config.breaker.failureRatio) {
    open(rt, node, `${failures}/${b.samples.length} calls failed in the last ${config.breaker.samplingMs / 1000} s`, correlationId)
  }
}

function open(rt: Runtime, node: NodeId, why: string, correlationId?: string) {
  const b = rt.state.breaker
  b.state = 'open'
  b.openedAt = rt.now
  rt.emit({
    from: node, to: node, kind: 'breaker', error: true, correlationId,
    label: `circuit OPEN (${why}): calls fail fast for ${config.breaker.breakMs / 1000} s`,
  })
}
