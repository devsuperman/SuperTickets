import type { Rng } from './rng'
import type { SimEvent, SimState } from './types'

// Discrete-event scheduler. Each concurrent activity (a request, a handler, a background loop) is a
// generator "process" that yields what it waits for; the scheduler resumes it at the right virtual time.
// Code between two yields runs atomically, which is how a database transaction is modelled.

export type Settled<T> = { ok: true; value: T } | { ok: false }

export type Wait =
  | { kind: 'sleep'; ms: number }
  | { kind: 'signal'; signal: Signal<unknown>; timeoutMs?: number }

export type Proc<T = void> = Generator<Wait, T, unknown>

/** Resolves once; processes can wait on it with an optional timeout. */
export class Signal<T> {
  done = false
  value: T | undefined
  private waiters: ((v: T) => void)[] = []

  resolve(v: T) {
    if (this.done) return
    this.done = true
    this.value = v
    for (const w of this.waiters.splice(0)) w(v)
  }

  onResolve(w: (v: T) => void) {
    this.waiters.push(w)
  }
}

interface Task { t: number; seq: number; run: () => void }

export class Runtime {
  private seq = 0
  private tasks: Task[] = []
  private events: SimEvent[] = []

  state: SimState
  rng: Rng

  constructor(state: SimState, rng: Rng) {
    this.state = state
    this.rng = rng
  }

  get now() {
    return this.state.now
  }

  emit(e: Omit<SimEvent, 't'>) {
    this.events.push({ t: this.now, ...e })
  }

  /** Starts a process now; it runs until its first wait before `spawn` returns. */
  spawn<T>(proc: Proc<T>): Signal<T> {
    const done = new Signal<T>()
    this.step(proc, undefined, done)
    return done
  }

  /** Runs every task due up to `until`, then moves the clock there. */
  run(until: number) {
    while (this.tasks.length > 0 && this.tasks[0].t <= until) {
      const task = this.tasks.shift()!
      this.state.now = task.t
      task.run()
    }
    this.state.now = until
  }

  drain(): SimEvent[] {
    return this.events.splice(0)
  }

  private at(t: number, run: () => void) {
    const task = { t, seq: this.seq++, run }
    let lo = 0
    let hi = this.tasks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const m = this.tasks[mid]
      if (m.t < t || (m.t === t && m.seq < task.seq)) lo = mid + 1
      else hi = mid
    }
    this.tasks.splice(lo, 0, task)
  }

  private step<T>(proc: Proc<T>, input: unknown, done: Signal<T>) {
    const r = proc.next(input)
    if (r.done) {
      done.resolve(r.value)
      return
    }
    const w = r.value
    if (w.kind === 'sleep') {
      this.at(this.now + Math.max(0, w.ms), () => this.step(proc, undefined, done))
      return
    }
    let settled = false
    const resume = (v: Settled<unknown>) => {
      if (settled) return
      settled = true
      this.at(this.now, () => this.step(proc, v, done))
    }
    if (w.signal.done) resume({ ok: true, value: w.signal.value })
    else {
      w.signal.onResolve((v) => resume({ ok: true, value: v }))
      if (w.timeoutMs !== undefined) this.at(this.now + w.timeoutMs, () => resume({ ok: false }))
    }
  }
}

export function* sleep(ms: number): Proc {
  yield { kind: 'sleep', ms }
}

export function* wait<T>(signal: Signal<T>, timeoutMs?: number): Proc<Settled<T>> {
  return (yield { kind: 'signal', signal: signal as Signal<unknown>, timeoutMs }) as Settled<T>
}
