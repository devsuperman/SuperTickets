import { useState } from 'react'
import { config, type Action, type SimState, type Toggles } from '../engine'
import { EVENT_ID, adminUpdate, get, placeOrder } from '../scenarios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

// The demo toggles of docs/project/contracts.md#configuration, plus service up/down.

type NumberToggle = 'paymentFailureRate' | 'inventoryDelayMs' | 'inventoryErrorRate' | 'notificationErrorRate'

const sliders: { key: NumberToggle; label: string; max: number; step: number; unit?: string }[] = [
  { key: 'paymentFailureRate', label: 'Payment failure rate', max: 1, step: 0.05 },
  { key: 'inventoryDelayMs', label: 'Inventory reserve delay', max: 5_000, step: 100, unit: 'ms' },
  { key: 'inventoryErrorRate', label: 'Inventory reserve error rate', max: 1, step: 0.05 },
  { key: 'notificationErrorRate', label: 'Notification error rate', max: 1, step: 0.05 },
]

const switches: { key: keyof Toggles; label: string }[] = [
  { key: 'redisUp', label: 'Redis' },
  { key: 'rabbitmqUp', label: 'RabbitMQ' },
  { key: 'workerUp', label: 'Worker' },
  { key: 'inventoryUp', label: 'Inventory' },
]

function ToggleSlider({ spec, value, onCommit }: { spec: (typeof sliders)[number]; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <Label htmlFor={spec.key}>{spec.label}</Label>
        <span className="tabular-nums text-muted-foreground">{shown}{spec.unit ? ` ${spec.unit}` : ''}</span>
      </div>
      <Slider
        id={spec.key} min={0} max={spec.max} step={spec.step} value={[shown]}
        onValueChange={([v]) => setDraft(v)}
        onValueCommit={([v]) => { setDraft(null); onCommit(v) }}
      />
    </div>
  )
}

export function Controls({ state, dispatch }: { state: SimState; dispatch: (a: Action) => void }) {
  const set = (key: keyof Toggles, value: number | boolean) => dispatch({ type: 'setToggle', key, value })
  return (
    <div className="space-y-4">
      {sliders.map((s) => (
        <ToggleSlider key={s.key} spec={s} value={state.toggles[s.key]} onCommit={(v) => set(s.key, v)} />
      ))}
      <Separator />
      <div className="grid grid-cols-2 gap-3">
        {switches.map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <Switch id={s.key} checked={state.toggles[s.key] as boolean} onCheckedChange={(v) => set(s.key, v)} />
            <Label htmlFor={s.key}>{s.label} {state.toggles[s.key] ? 'up' : 'down'}</Label>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Sandbox: send requests by hand, like curl against the gateway. */
export function RequestPanel({ state, dispatch, skip }: { state: SimState; dispatch: (a: Action) => void; skip: (ms: number) => void }) {
  const [quantity, setQuantity] = useState(1)
  const [key, setKey] = useState('key-1')
  const [burst, setBurst] = useState(160)
  const event = state.catalog.events.find((e) => e.id === EVENT_ID)
  const lastOrder = state.orders.orders.at(-1)
  const stock = state.inventory.stock.find((s) => s.eventId === EVENT_ID)

  const nextKey = () => setKey(`key-${state.orders.orders.length + 1}-${Math.floor(state.now)}`)

  return (
    <div className="space-y-4 text-sm">
      <div className="text-muted-foreground">
        Event <span className="font-medium text-foreground">{event?.name}</span>: {stock?.available}/{stock?.totalTickets} available, price {event?.price}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => dispatch(get('/events'))}>GET /events</Button>
        <Button size="sm" variant="outline" onClick={() => dispatch(get(`/events/${EVENT_ID}`))}>GET /events/{'{id}'}</Button>
        <Button size="sm" variant="outline" onClick={() => dispatch(get(`/events/${EVENT_ID}/availability`))}>GET availability</Button>
        <Button size="sm" variant="outline" disabled={!lastOrder} onClick={() => lastOrder && dispatch(get(`/orders/${lastOrder.id}`))}>GET last order</Button>
      </div>
      <Separator />
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <div className="space-y-1">
          <Label htmlFor="idem">Idempotency-Key (reuse it to retry)</Label>
          <Input id="idem" value={key} maxLength={100} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="qty">Quantity</Label>
          <Input id="qty" type="number" min={1} max={10} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => dispatch(placeOrder(key, quantity))}>POST /orders</Button>
        <Button size="sm" variant="outline" onClick={nextKey}>New key</Button>
        <Button size="sm" variant="outline" onClick={() => dispatch(placeOrder(null, quantity))}>POST without key</Button>
      </div>
      <Separator />
      <div className="flex flex-wrap items-end gap-2">
        <Button
          size="sm" variant="outline" disabled={!event}
          onClick={() => event && dispatch(adminUpdate({ price: event.price + 5, totalTickets: event.totalTickets }))}
        >
          Admin: price +5
        </Button>
        <Button
          size="sm" variant="outline" disabled={!event}
          onClick={() => event && dispatch(adminUpdate({ price: event.price, totalTickets: Math.max(1, event.totalTickets - 5) }))}
        >
          Admin: capacity −5
        </Button>
      </div>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="burst">Burst size</Label>
          <Input id="burst" type="number" min={1} max={500} value={burst} className="w-24" onChange={(e) => setBurst(Number(e.target.value))} />
        </div>
        <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'burst', count: Math.min(500, Math.max(1, burst)), path: '/events' })}>
          Burst GET /events
        </Button>
      </div>
      <Separator />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => skip(1_000)}>Skip 1 s</Button>
        <Button size="sm" variant="ghost" onClick={() => skip(config.breaker.breakMs)}>Skip {config.breaker.breakMs / 1000} s</Button>
        <Button size="sm" variant="ghost" onClick={() => skip(config.cacheTtlMs)}>Skip {config.cacheTtlMs / 1000} s</Button>
        <Button size="sm" variant="ghost" onClick={() => skip(config.pendingTimeoutMs + config.sweepIntervalMs)}>Skip 5.5 min</Button>
      </div>
    </div>
  )
}
