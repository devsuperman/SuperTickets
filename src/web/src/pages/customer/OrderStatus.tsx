import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ApiError, getEvent, getOrder, type CancelReason } from '@/api'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const reasons: Record<CancelReason, string> = {
  sold_out: 'The tickets sold out before your order could be reserved.',
  payment_failed: 'Your payment was declined. Nothing was charged.',
  expired: 'Your order was not completed in time and expired.',
}

export default function OrderStatus() {
  const { id = '' } = useParams()
  const { data: order, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => getOrder(id),
    refetchInterval: (q) => {
      const o = q.state.data
      // Tickets are created asynchronously after payment, so keep polling until they exist.
      const done = o && (o.status === 'cancelled' || (o.status === 'paid' && o.tickets.length >= o.quantity))
      return done ? false : 2000
    },
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 3,
  })
  const event = useQuery({
    queryKey: ['event', order?.eventId],
    queryFn: () => getEvent(order!.eventId),
    enabled: !!order,
  })

  if (error instanceof ApiError && error.status === 404) return <p>Order not found.</p>
  if (!order) return <p className="text-muted-foreground">Loading...</p>

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-2xl">
          Order
          <Badge variant={order.status === 'cancelled' ? 'destructive' : 'secondary'}>{order.status}</Badge>
        </CardTitle>
        <CardDescription>
          {order.quantity} x{' '}
          <Link to={`/event/${order.eventId}`} className="underline">{event.data?.name ?? 'event'}</Link>
          {' '}for {order.customerEmail}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {order.status === 'pending' && <p>Processing your payment...</p>}
        {order.status === 'cancelled' && (
          <p className="text-destructive">
            {order.cancelReason ? reasons[order.cancelReason] : 'The order was cancelled.'}
          </p>
        )}
        {order.status === 'paid' && (
          <>
            <p>Payment received. A confirmation was sent to {order.customerEmail}.</p>
            {order.tickets.length === 0 ? (
              <p className="text-muted-foreground">Issuing your tickets...</p>
            ) : (
              <ul className="space-y-1">
                {order.tickets.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    Ticket #{t.number} <Badge variant="outline">{t.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
