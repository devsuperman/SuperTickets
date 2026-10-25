import { useEffect, useState } from 'react'
import { catalogHealth, type NodeId, type SimEventKind, type SimState } from '../engine'
import { cn } from '@/lib/utils'
import type { LogEntry } from './usePlayer'

// Inline SVG of the Compose stack. Each SimEvent between two nodes flies as a dot; events on one node pulse it.

const W = 120
const H = 44
const FLIGHT_MS = 650
const MAX_FLIGHTS = 120

const pos: Record<NodeId, { x: number; y: number; label: string }> = {
  browser: { x: 70, y: 185, label: 'Browser' },
  web: { x: 215, y: 50, label: 'web (SPA)' },
  gateway: { x: 215, y: 185, label: 'nginx gateway' },
  'catalog-1': { x: 395, y: 50, label: 'catalog-api #1' },
  'catalog-2': { x: 395, y: 120, label: 'catalog-api #2' },
  inventory: { x: 395, y: 210, label: 'inventory-api' },
  order: { x: 395, y: 300, label: 'order-api' },
  redis: { x: 590, y: 50, label: 'Redis' },
  postgres: { x: 590, y: 175, label: 'Postgres' },
  rabbitmq: { x: 590, y: 300, label: 'RabbitMQ' },
  worker: { x: 760, y: 240, label: 'worker' },
}

const edges: [NodeId, NodeId][] = [
  ['browser', 'gateway'], ['gateway', 'web'],
  ['gateway', 'catalog-1'], ['gateway', 'catalog-2'], ['gateway', 'inventory'], ['gateway', 'order'],
  ['catalog-1', 'redis'], ['catalog-2', 'redis'], ['catalog-1', 'postgres'], ['catalog-2', 'postgres'],
  ['catalog-2', 'inventory'], ['inventory', 'postgres'], ['order', 'inventory'], ['order', 'postgres'],
  ['order', 'rabbitmq'], ['rabbitmq', 'worker'], ['worker', 'postgres'], ['worker', 'inventory'],
]

const kindColor: Record<SimEventKind, string> = {
  http: 'fill-sky-500', response: 'fill-emerald-500', sql: 'fill-indigo-500', cache: 'fill-orange-500',
  publish: 'fill-violet-500', deliver: 'fill-violet-500', ack: 'fill-emerald-500', nack: 'fill-destructive',
  dlq: 'fill-destructive', retry: 'fill-amber-500', breaker: 'fill-amber-500', timer: 'fill-amber-500', log: 'fill-muted-foreground',
}

const legend: [string, SimEventKind][] = [
  ['HTTP', 'http'], ['response', 'response'], ['SQL', 'sql'], ['Redis', 'cache'], ['message', 'publish'], ['retry / breaker', 'retry'],
]

function status(id: NodeId, s: SimState): { text: string; bad?: boolean; warn?: boolean } | null {
  const t = s.toggles
  const q = s.broker.queues
  switch (id) {
    case 'catalog-1':
    case 'catalog-2': {
      const h = catalogHealth({ state: s })
      return { text: h, warn: h !== 'healthy' }
    }
    case 'redis': return t.redisUp ? { text: `${Object.keys(s.redis).length} keys` } : { text: 'down', bad: true }
    case 'inventory':
      if (!t.inventoryUp) return { text: 'down', bad: true }
      if (t.inventoryErrorRate > 0 || t.inventoryDelayMs > 0)
        return { text: `delay ${t.inventoryDelayMs} ms · err ${t.inventoryErrorRate}`, warn: true }
      return { text: 'up' }
    case 'order': return { text: `breaker ${s.breaker.state}`, bad: s.breaker.state === 'open', warn: s.breaker.state === 'half-open' }
    case 'rabbitmq':
      if (!t.rabbitmqUp) return { text: 'down', bad: true }
      return {
        text: `pay ${q['payment-queue'].length} · notif ${q['notification-queue'].length} · dlq ${q['payment-dlq'].length + q['notification-dlq'].length}`,
        warn: q['payment-dlq'].length + q['notification-dlq'].length > 0,
      }
    case 'worker': return t.workerUp ? { text: 'up' } : { text: 'down', bad: true }
    case 'postgres': return { text: `${s.orders.orders.length} orders` }
    default: return null
  }
}

const center = (id: NodeId) => pos[id]

export function ArchitectureDiagram({ state, log }: { state: SimState; log: LogEntry[] }) {
  const [now, setNow] = useState(() => performance.now())

  // Re-render every frame while something is (or is about to be) in flight.
  const latest = log.length > 0 ? log[log.length - 1].at : 0
  useEffect(() => {
    let frame = requestAnimationFrame(function loop(t) {
      setNow(t)
      if (t < latest + FLIGHT_MS) frame = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(frame)
  }, [latest])

  const active: LogEntry[] = []
  for (let i = log.length - 1; i >= 0 && active.length < MAX_FLIGHTS; i--) {
    const e = log[i]
    if (e.at + FLIGHT_MS < now - 2_000) break // older entries are all finished
    if (e.at <= now && now < e.at + FLIGHT_MS) active.push(e)
  }
  const busy = new Set(active.flatMap((e) => [e.from, e.to]))
  const errored = new Set(active.filter((e) => e.error).map((e) => e.from))

  return (
    <div className="space-y-2">
      <svg viewBox="0 0 840 340" className="w-full" role="img" aria-label="SuperTickets architecture with animated requests and messages">
        {edges.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={center(a).x} y1={center(a).y} x2={center(b).x} y2={center(b).y} className="stroke-border" strokeWidth={1.5} />
        ))}
        {(Object.keys(pos) as NodeId[]).map((id) => {
          const p = pos[id]
          const st = status(id, state)
          return (
            <g key={id}>
              <rect
                x={p.x - W / 2} y={p.y - H / 2} width={W} height={H} rx={8}
                className={cn(
                  'fill-card stroke-border transition-colors',
                  busy.has(id) && 'stroke-primary',
                  st?.warn && 'stroke-amber-500',
                  (st?.bad || errored.has(id)) && 'stroke-destructive',
                )}
                strokeWidth={busy.has(id) || st?.bad || st?.warn ? 2.5 : 1.5}
              />
              <text x={p.x} y={st ? p.y - 3 : p.y + 4} textAnchor="middle" className="fill-foreground text-[12px] font-medium">{p.label}</text>
              {st && (
                <text
                  x={p.x} y={p.y + 13} textAnchor="middle"
                  className={cn('text-[10px]', st.bad ? 'fill-destructive' : st.warn ? 'fill-amber-600' : 'fill-muted-foreground')}
                >
                  {st.text}
                </text>
              )}
            </g>
          )
        })}
        {active.map((e) => {
          const f = Math.min(1, (now - e.at) / FLIGHT_MS)
          if (e.from === e.to) {
            const p = center(e.from)
            return (
              <rect
                key={e.seq} x={p.x - W / 2 - 4 * f} y={p.y - H / 2 - 4 * f} width={W + 8 * f} height={H + 8 * f} rx={10}
                className={cn('fill-none', e.error ? 'stroke-destructive' : 'stroke-amber-500')} strokeWidth={2} opacity={1 - f}
              />
            )
          }
          const a = center(e.from)
          const b = center(e.to)
          return (
            <circle
              key={e.seq} cx={a.x + (b.x - a.x) * f} cy={a.y + (b.y - a.y) * f} r={5}
              className={cn(e.error ? 'fill-destructive' : kindColor[e.kind], 'stroke-background')} strokeWidth={1.5}
            />
          )
        })}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {legend.map(([label, kind]) => (
          <span key={label} className="flex items-center gap-1">
            <svg viewBox="0 0 10 10" className="size-2.5"><circle cx={5} cy={5} r={5} className={kindColor[kind]} /></svg>
            {label}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <svg viewBox="0 0 10 10" className="size-2.5"><circle cx={5} cy={5} r={5} className="fill-destructive" /></svg>
          error
        </span>
      </div>
    </div>
  )
}
