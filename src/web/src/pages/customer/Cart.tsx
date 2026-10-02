import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { ApiError, createOrder } from '@/api'
import { removeFromCart, setEmail, setQuantity, useCart } from '@/cart/cart'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const emailOk = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

function problemMessage(err: unknown, name: string) {
  if (err instanceof ApiError) {
    if (err.problem.type === 'sold_out') return `${name}: not enough tickets left.`
    if (err.problem.type === 'dependency_unavailable')
      return `${name}: service temporarily unavailable. Try again in a moment.`
    if (err.status === 404) return `${name}: event no longer exists.`
    if (err.status === 400) return `${name}: ${err.message}`
  }
  return `${name}: something went wrong. Try again.`
}

export default function Cart() {
  const { email, items } = useCart()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [orders, setOrders] = useState<{ id: string; name: string }[]>([])

  const total = items.reduce((s, i) => s + i.price * i.quantity, 0)
  const valid = emailOk(email.trim())

  async function checkout() {
    setBusy(true)
    setErrors({})
    const placed: { id: string; name: string }[] = []
    const failed: Record<string, string> = {}
    for (const item of items) {
      try {
        // Same key on retry, so a failed or repeated attempt never creates a second order.
        const order = await createOrder(
          { eventId: item.eventId, quantity: item.quantity, customerEmail: email.trim() },
          item.key,
        )
        placed.push({ id: order.id, name: item.name })
        removeFromCart(item.eventId)
      } catch (err) {
        failed[item.eventId] = problemMessage(err, item.name)
      }
    }
    setBusy(false)
    setErrors(failed)
    if (Object.keys(failed).length) toast.error('Some items could not be ordered.')
    if (placed.length === 1 && !Object.keys(failed).length) navigate(`/order/${placed[0].id}`)
    else setOrders((o) => [...o, ...placed])
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Cart</h1>
      {orders.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Orders placed</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {orders.map((o) => (
              <div key={o.id}>
                <Link to={`/order/${o.id}`} className="underline">{o.name}</Link>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {items.length === 0 ? (
        <p className="text-muted-foreground">
          Your cart is empty. <Link to="/" className="underline">Browse events</Link>
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead className="w-28">Quantity</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.eventId}>
                  <TableCell>
                    <Link to={`/event/${i.eventId}`} className="hover:underline">{i.name}</Link>
                    {errors[i.eventId] && <p className="text-sm text-destructive">{errors[i.eventId]}</p>}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      aria-label={`Quantity for ${i.name}`}
                      value={i.quantity}
                      onChange={(e) => setQuantity(i.eventId, e.target.valueAsNumber)}
                    />
                  </TableCell>
                  <TableCell className="text-right">${(i.price * i.quantity).toFixed(2)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => removeFromCart(i.eventId)}>Remove</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-right font-medium">Total: ${total.toFixed(2)}</p>
          <div className="max-w-sm space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              maxLength={254}
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
            {email && !valid && <p className="text-sm text-destructive">Enter a valid email.</p>}
          </div>
          <Button onClick={checkout} disabled={busy || !valid}>
            {busy ? 'Placing order...' : 'Place order'}
          </Button>
        </>
      )}
    </div>
  )
}
