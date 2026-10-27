import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { config, type QueueName, type SimState } from '../engine'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { EventLog } from './EventLog'
import { seconds, short } from './format'
import type { LogEntry } from './usePlayer'

// What the real stores hold right now, one tab per store. Rows flash when they change.

const flash = 'bg-amber-100 dark:bg-amber-500/20'

/** Props of every tab: the snapshot plus the row keys that just changed (usePlayer rowKeys). */
interface TabProps { state: SimState; changed: Set<string> }
const queues: QueueName[] = ['payment-queue', 'notification-queue', 'payment-dlq', 'notification-dlq']

function Scroll({ children }: { children: ReactNode }) {
  return <div className="max-h-80 overflow-auto rounded-md border">{children}</div>
}

const Empty = ({ cols, text }: { cols: number; text: string }) => (
  <TableRow><TableCell colSpan={cols} className="text-muted-foreground">{text}</TableCell></TableRow>
)

const statusVariant = (s: number) => (s >= 500 || s === 429 ? 'destructive' : s >= 400 ? 'secondary' : 'outline')

const chartConfig = { count: { label: 'Requests', color: 'var(--chart-2)' } } satisfies ChartConfig

function Requests({ state, changed }: TabProps) {
  const rows = state.requests
  const hl = (r: { id: string }) => changed.has(`req/${r.id}`)
  const counts = new Map<string, number>()
  for (const r of rows) {
    const k = r.response ? String(r.response.status) : 'pending'
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const data = [...counts].sort().map(([status, count]) => ({ status, count }))
  return (
    <div className="space-y-3">
      {rows.length > 1 && (
        <ChartContainer config={chartConfig} className="h-32 w-full">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="status" tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} width={32} tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={4} />
          </BarChart>
        </ChartContainer>
      )}
      <Scroll>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Request</TableHead><TableHead>Status</TableHead><TableHead>X-Cache</TableHead><TableHead>X-Upstream</TableHead><TableHead>Took</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && <Empty cols={5} text="No browser requests yet." />}
            {rows.map((r) => (
              <TableRow key={r.id} className={cn(hl(r) && flash)}>
                <TableCell className="font-mono text-xs">{r.method} {r.path}</TableCell>
                <TableCell>{r.response ? <Badge variant={statusVariant(r.response.status)}>{r.response.status}</Badge> : '…'}</TableCell>
                <TableCell>{r.response?.headers['X-Cache'] ?? ''}</TableCell>
                <TableCell>{r.response?.headers['X-Upstream'] ?? ''}</TableCell>
                <TableCell>{r.doneAt !== null ? `${r.doneAt - r.sentAt} ms` : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Scroll>
    </div>
  )
}

function Orders({ state, changed }: TabProps) {
  const { orders, payments, tickets } = state.orders
  const rows = orders.map((o) => ({
    ...o,
    payment: payments.find((p) => p.orderId === o.id),
    tickets: tickets.filter((t) => t.orderId === o.id).map((t) => t.number).sort((a, b) => a - b),
  }))
  const hl = (o: { id: string }) => changed.has(`order/${o.id}`)
  return (
    <Scroll>
      <Table>
        <TableHeader>
          <TableRow><TableHead>id</TableHead><TableHead>idempotency_key</TableHead><TableHead>qty</TableHead><TableHead>status</TableHead><TableHead>payment</TableHead><TableHead>tickets</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && <Empty cols={6} text="No orders." />}
          {rows.map((o) => (
            <TableRow key={o.id} className={cn(hl(o) && flash)}>
              <TableCell className="font-mono text-xs">{short(o.id)}</TableCell>
              <TableCell className="font-mono text-xs">{o.idempotencyKey}</TableCell>
              <TableCell>{o.quantity}</TableCell>
              <TableCell>
                <Badge variant={o.status === 'paid' ? 'default' : o.status === 'cancelled' ? 'destructive' : 'secondary'}>{o.status}</Badge>
                {o.cancelReason && <span className="ml-1 text-xs text-muted-foreground">{o.cancelReason}</span>}
              </TableCell>
              <TableCell>{o.payment ? (o.payment.succeeded ? 'succeeded' : 'declined') : ''}</TableCell>
              <TableCell>{o.tickets.join(', ')}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroll>
  )
}

function Stock({ state, changed }: TabProps) {
  const { stock, reservations } = state.inventory
  const hlStock = (s: { eventId: string }) => changed.has(`stock/${s.eventId}`)
  const hlRes = (r: { orderId: string }) => changed.has(`res/${r.orderId}`)
  return (
    <div className="space-y-3">
      <Scroll>
        <Table>
          <TableHeader><TableRow><TableHead>stock.event_id</TableHead><TableHead>total_tickets</TableHead><TableHead>available</TableHead></TableRow></TableHeader>
          <TableBody>
            {stock.map((s) => (
              <TableRow key={s.eventId} className={cn(hlStock(s) && flash)}>
                <TableCell className="font-mono text-xs">{short(s.eventId)}</TableCell>
                <TableCell>{s.totalTickets}</TableCell>
                <TableCell className="font-medium">{s.available}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Scroll>
      <Scroll>
        <Table>
          <TableHeader><TableRow><TableHead>reservations.order_id</TableHead><TableHead>quantity</TableHead><TableHead>status</TableHead></TableRow></TableHeader>
          <TableBody>
            {reservations.length === 0 && <Empty cols={3} text="No reservations." />}
            {reservations.map((r) => (
              <TableRow key={r.orderId} className={cn(hlRes(r) && flash)}>
                <TableCell className="font-mono text-xs">{short(r.orderId)}</TableCell>
                <TableCell>{r.quantity}</TableCell>
                <TableCell><Badge variant={r.status === 'active' ? 'secondary' : 'outline'}>{r.status}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Scroll>
    </div>
  )
}

function Outbox({ state, changed, onRedeliver }: TabProps & { onRedeliver: (id: string) => void }) {
  const rows = state.orders.outbox
  const hl = (r: { id: string }) => changed.has(`outbox/${r.id}`)
  return (
    <Scroll>
      <Table>
        <TableHeader><TableRow><TableHead>type</TableHead><TableHead>correlation_id</TableHead><TableHead>created_at</TableHead><TableHead>published_at</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          {rows.length === 0 && <Empty cols={5} text="Outbox is empty." />}
          {rows.map((r) => (
            <TableRow key={r.id} className={cn(hl(r) && flash)}>
              <TableCell>{r.type}</TableCell>
              <TableCell className="font-mono text-xs">{r.correlationId}</TableCell>
              <TableCell>{seconds(r.createdAt)}</TableCell>
              <TableCell>{r.publishedAt === null ? <Badge variant="secondary">waiting</Badge> : seconds(r.publishedAt)}</TableCell>
              <TableCell>
                <Button
                  size="sm" variant="outline" disabled={r.publishedAt === null || !state.toggles.rabbitmqUp}
                  title="Publish this row again, as if the publisher crashed before marking it" onClick={() => onRedeliver(r.id)}
                >
                  Redeliver
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Scroll>
  )
}

function Queues({ state, changed }: TabProps) {
  const rows = queues.flatMap((q) => state.broker.queues[q].map((m) => ({ q, ...m })))
  const hl = (m: { q: string; messageId: string }) => changed.has(`msg/${m.q}/${m.messageId}`)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {queues.map((q) => (
          <div key={q} className={cn('rounded-md border p-2', q.endsWith('dlq') && state.broker.queues[q].length > 0 && 'border-destructive')}>
            <div className="text-xs text-muted-foreground">{q}</div>
            <div className="text-xl font-semibold">{state.broker.queues[q].length}</div>
          </div>
        ))}
      </div>
      <Scroll>
        <Table>
          <TableHeader><TableRow><TableHead>queue</TableHead><TableHead>type</TableHead><TableHead>deliveries</TableHead><TableHead>state</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 && <Empty cols={4} text="All queues are empty." />}
            {rows.map((m) => (
              <TableRow key={`${m.q}/${m.messageId}`} className={cn(hl(m) && flash)}>
                <TableCell>{m.q}</TableCell>
                <TableCell>{m.type}</TableCell>
                <TableCell>{m.deliveryCount}/{config.maxDeliveries}</TableCell>
                <TableCell>{m.q.endsWith('dlq') ? <Badge variant="destructive">dead-lettered</Badge> : m.unacked ? 'unacked' : 'ready'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Scroll>
    </div>
  )
}

function Cache({ state, changed }: TabProps) {
  const rows = Object.entries(state.redis).map(([key, e]) => ({ key, ...e }))
  const hl = (r: { key: string }) => changed.has(`redis/${r.key}`)
  const maxTtl = config.cacheTtlMs * (1 + config.cacheJitter)
  return (
    <Scroll>
      <Table>
        <TableHeader><TableRow><TableHead>key</TableHead><TableHead>value</TableHead><TableHead className="w-40">TTL</TableHead></TableRow></TableHeader>
        <TableBody>
          {!state.toggles.redisUp && <Empty cols={3} text="Redis is down." />}
          {state.toggles.redisUp && rows.length === 0 && <Empty cols={3} text="No keys." />}
          {rows.map((r) => {
            const left = r.expiresAt === null ? null : Math.max(0, r.expiresAt - state.now)
            return (
              <TableRow key={r.key} className={cn(hl(r) && flash, left === 0 && 'text-muted-foreground line-through')}>
                <TableCell className="font-mono text-xs">{r.key}</TableCell>
                <TableCell className="max-w-48 truncate font-mono text-xs">{JSON.stringify(r.value)}</TableCell>
                <TableCell>
                  {left === null ? 'no TTL' : (
                    <div className="space-y-1">
                      <span className="text-xs">{(left / 1000).toFixed(1)} s</span>
                      <Progress value={(left / maxTtl) * 100} />
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Scroll>
  )
}

function Breaker({ state }: { state: SimState }) {
  const b = state.breaker
  const { failureRatio, minimumThroughput, samplingMs, breakMs } = config.breaker
  const inWindow = b.samples.filter((s) => s.t > state.now - samplingMs)
  const failures = inWindow.filter((s) => !s.ok).length
  const ratio = inWindow.length ? failures / inWindow.length : 0
  const reopensIn = b.state === 'open' && b.openedAt !== null ? Math.max(0, b.openedAt + breakMs - state.now) : null
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2">
        Order → Inventory reserve:
        <Badge variant={b.state === 'open' ? 'destructive' : b.state === 'half-open' ? 'secondary' : 'outline'}>{b.state}</Badge>
      </div>
      <div className="space-y-1">
        <div>Failures in the last {samplingMs / 1000} s: {failures}/{inWindow.length} calls ({Math.round(ratio * 100)} %)</div>
        <Progress value={ratio * 100} />
        <div className="text-xs text-muted-foreground">
          Opens at ≥ {failureRatio * 100} % failures with at least {minimumThroughput} calls in the window.
        </div>
      </div>
      {reopensIn !== null && (
        <div>
          {reopensIn > 0
            ? `Open: the next call ${(reopensIn / 1000).toFixed(1)} s from now is the half-open trial.`
            : 'Break is over: the next call is the half-open trial.'}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {inWindow.map((s, i) => <Badge key={i} variant={s.ok ? 'outline' : 'destructive'}>{seconds(s.t)}</Badge>)}
      </div>
    </div>
  )
}

export function Inspector({ state, changed, log, onRedeliver }: TabProps & { log: LogEntry[]; onRedeliver: (id: string) => void }) {
  return (
    <Tabs defaultValue="requests">
      <TabsList className="h-auto flex-wrap">
        <TabsTrigger value="requests">Requests</TabsTrigger>
        <TabsTrigger value="orders">Orders</TabsTrigger>
        <TabsTrigger value="stock">Stock</TabsTrigger>
        <TabsTrigger value="outbox">Outbox</TabsTrigger>
        <TabsTrigger value="queues">Queues + DLQ</TabsTrigger>
        <TabsTrigger value="cache">Cache keys</TabsTrigger>
        <TabsTrigger value="breaker">Breaker</TabsTrigger>
        <TabsTrigger value="log">Log</TabsTrigger>
      </TabsList>
      <TabsContent value="requests"><Requests state={state} changed={changed} /></TabsContent>
      <TabsContent value="orders"><Orders state={state} changed={changed} /></TabsContent>
      <TabsContent value="stock"><Stock state={state} changed={changed} /></TabsContent>
      <TabsContent value="outbox"><Outbox state={state} changed={changed} onRedeliver={onRedeliver} /></TabsContent>
      <TabsContent value="queues"><Queues state={state} changed={changed} /></TabsContent>
      <TabsContent value="cache"><Cache state={state} changed={changed} /></TabsContent>
      <TabsContent value="breaker"><Breaker state={state} /></TabsContent>
      <TabsContent value="log"><EventLog log={log} /></TabsContent>
    </Tabs>
  )
}
