import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, getAvailability, getEvent } from '@/api'
import { addToCart, clampQuantity } from '@/cart/cart'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function EventDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [quantity, setQuantity] = useState(1)
  const event = useQuery({ queryKey: ['event', id], queryFn: () => getEvent(id) })
  const availability = useQuery({
    queryKey: ['availability', id],
    queryFn: () => getAvailability(id),
    refetchInterval: 10_000,
  })

  if (event.error instanceof ApiError && event.error.status === 404)
    return <p>Event not found. <Link to="/" className="underline">Back to events</Link></p>
  if (event.error) return <p className="text-destructive">Could not load the event.</p>
  if (!event.data) return <p className="text-muted-foreground">Loading...</p>

  const e = event.data
  const available = availability.data?.available
  const soldOut = available === 0

  const add = () => {
    addToCart({ eventId: e.id, name: e.name, price: e.price, quantity })
    toast.success('Added to cart')
    navigate('/cart')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{e.name}</CardTitle>
        <CardDescription>
          {e.venue} · {new Date(e.startsAt).toLocaleString()}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-lg font-medium">${e.price.toFixed(2)}</span>
          {available === undefined ? (
            <Badge variant="secondary">Availability unavailable</Badge>
          ) : soldOut ? (
            <Badge variant="destructive">Sold out</Badge>
          ) : (
            <Badge variant="secondary">{available} available</Badge>
          )}
        </div>
        <div className="flex max-w-xs items-end gap-2">
          <div className="space-y-2">
            <Label htmlFor="quantity">Quantity (1-10)</Label>
            <Input
              id="quantity"
              type="number"
              min={1}
              max={10}
              value={quantity}
              onChange={(ev) => setQuantity(clampQuantity(ev.target.valueAsNumber))}
            />
          </div>
          <Button onClick={add} disabled={soldOut}>Add to cart</Button>
        </div>
      </CardContent>
    </Card>
  )
}
