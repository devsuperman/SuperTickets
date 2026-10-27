import { useCallback, useEffect, useRef, useState } from 'react'
import { createSim, type Action, type Sim, type SimEvent, type SimState } from '../engine'
import { stepActions, type Scenario } from '../scenarios'

/** Playback speeds, as multiples of real time. */
export const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
export const DEFAULT_SPEED = 3 // ×0.5: one request is still quick to watch, the 1 s outbox poll takes 2 s
/** Extra multiplier for steps marked fastForward (TTL, breaker, sweeper). */
const FAST_FORWARD = 100
const MAX_LOG = 3_000
const HIGHLIGHT_MS = 1_500

/** A SimEvent plus when (performance.now) the diagram should start animating it. */
export type LogEntry = SimEvent & { seq: number; at: number }

export interface Player {
  state: SimState
  log: LogEntry[]
  /** Inspector row keys (see rowKeys) that changed in the last 1.5 s of playback. */
  changed: Set<string>
  /** Index of the step that is running or ran last; -1 before the first. */
  current: number
  /** True while `current` still has clock time left to play. */
  running: boolean
  playing: boolean
  done: boolean
  speed: number
  setSpeed: (i: number) => void
  run: () => void
  step: () => void
  pause: () => void
  reset: () => void
  /** Manual action (controls, sandbox buttons, redeliver). */
  dispatch: (a: Action) => void
  /** Runs the clock forward at once (sandbox "skip"). */
  skip: (ms: number) => void
}

/** One key per inspector row, with its content, so changed rows can be highlighted. */
function rowKeys(s: SimState): Map<string, string> {
  const m = new Map<string, string>()
  const add = (k: string, v: unknown) => m.set(k, JSON.stringify(v))
  for (const r of s.requests) add(`req/${r.id}`, r)
  for (const o of s.orders.orders) {
    add(`order/${o.id}`, [o, s.orders.payments.find((p) => p.orderId === o.id), s.orders.tickets.filter((t) => t.orderId === o.id).length])
  }
  for (const r of s.orders.outbox) add(`outbox/${r.id}`, r)
  for (const r of s.inventory.stock) add(`stock/${r.eventId}`, r)
  for (const r of s.inventory.reservations) add(`res/${r.orderId}`, r)
  for (const [q, msgs] of Object.entries(s.broker.queues)) for (const msg of msgs) add(`msg/${q}/${msg.messageId}`, msg)
  for (const [k, v] of Object.entries(s.redis)) add(`redis/${k}`, v)
  return m
}

/** Mutable playback state, changed only from event handlers and the animation frame loop. */
interface Inner {
  sim: Sim
  current: number
  remaining: number
  mode: 'run' | 'step' | null
  seq: number
  speed: number
  rows: Map<string, string>
  until: Map<string, number>
}

interface View {
  state: SimState
  log: LogEntry[]
  changed: Set<string>
  current: number
  running: boolean
  playing: boolean
}

export function usePlayer(scenario: Scenario): Player {
  const steps = scenario.steps
  const sandbox = steps.length === 0

  const fresh = (speed: number): Inner => {
    const sim = createSim(scenario.options)
    return { sim, current: -1, remaining: 0, mode: null, seq: 0, speed, rows: rowKeys(sim.state), until: new Map() }
  }
  const [initial] = useState(() => fresh(DEFAULT_SPEED))
  const inner = useRef(initial)
  const [view, setView] = useState<View>(() => ({
    state: initial.sim.state, log: [], changed: new Set(), current: -1, running: false, playing: false,
  }))
  const [speed, setSpeedState] = useState(DEFAULT_SPEED)

  /** Copies the simulation into React state; events are scheduled for the diagram by their virtual time. */
  const publish = useCallback((events: SimEvent[], startT: number, virtualPerRealMs: number) => {
    const p = inner.current
    const now = performance.now()
    const state = p.sim.state
    const rows = rowKeys(state)
    for (const [k, v] of rows) if (p.rows.get(k) !== v) p.until.set(k, now + HIGHLIGHT_MS)
    p.rows = rows
    const changed = new Set([...p.until].filter(([, t]) => t > now).map(([k]) => k))
    const entries = events.map((e) => ({ ...e, seq: p.seq++, at: now + (e.t - startT) / virtualPerRealMs }))
    setView((v) => ({
      state,
      log: entries.length === 0 ? v.log : [...v.log, ...entries].slice(-MAX_LOG),
      changed,
      current: p.current,
      running: p.remaining > 0,
      playing: p.mode !== null,
    }))
  }, [])

  /** Plays `realMs` of wall time, starting the next step when the current one is used up. */
  const tick = useCallback((realMs: number) => {
    const p = inner.current
    const base = SPEEDS[p.speed]
    if (sandbox) {
      const startT = p.sim.state.now
      publish(p.sim.advance(realMs * base), startT, base)
      return
    }
    if (p.remaining === 0) {
      if (p.current + 1 >= steps.length) {
        p.mode = null
        publish([], 0, 1)
        return
      }
      p.current++
      for (const a of stepActions(steps[p.current], p.sim.state)) p.sim.dispatch(a)
      p.remaining = steps[p.current].runMs
    }
    const rate = base * (steps[p.current].fastForward ? FAST_FORWARD : 1)
    const chunk = Math.min(p.remaining, realMs * rate)
    const startT = p.sim.state.now
    const events = p.sim.advance(chunk)
    p.remaining -= chunk
    if (p.remaining === 0 && (p.mode === 'step' || p.current + 1 >= steps.length)) p.mode = null
    publish(events, startT, rate)
  }, [publish, sandbox, steps])

  useEffect(() => {
    if (!view.playing) return
    let last = performance.now()
    let frame = requestAnimationFrame(function loop(now) {
      tick(Math.min(now - last, 100))
      last = now
      if (inner.current.mode !== null) frame = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(frame)
  }, [view.playing, tick])

  const start = (mode: 'run' | 'step') => {
    const p = inner.current
    if (!sandbox && p.remaining === 0 && p.current + 1 >= steps.length) return
    p.mode = mode
    setView((v) => ({ ...v, playing: true }))
  }

  return {
    ...view,
    done: !sandbox && view.current === steps.length - 1 && !view.running,
    speed,
    setSpeed: (i) => {
      inner.current.speed = i
      setSpeedState(i)
    },
    run: () => start('run'),
    step: () => start('step'),
    pause: () => {
      inner.current.mode = null
      setView((v) => ({ ...v, playing: false }))
    },
    reset: () => {
      inner.current = fresh(inner.current.speed)
      setView({ state: inner.current.sim.state, log: [], changed: new Set(), current: -1, running: false, playing: false })
    },
    dispatch: (a) => {
      const p = inner.current
      p.sim.dispatch(a)
      publish(p.sim.advance(0), p.sim.state.now, 1)
    },
    skip: (ms) => {
      const p = inner.current
      publish(p.sim.advance(ms), p.sim.state.now, Infinity)
    },
  }
}
