// DTOs mirror docs/project/contracts.md#payloads.
export interface EventDto {
  id: string
  name: string
  venue: string
  startsAt: string
  totalTickets: number
  price: number
}

/** POST/PUT /admin/events body: EventDto without id. */
export type EventInput = Omit<EventDto, 'id'>

export interface AvailabilityDto {
  eventId: string
  available: number
}

export interface CreateOrderRequest {
  eventId: string
  quantity: number
  customerEmail: string
}

export type OrderStatus = 'pending' | 'paid' | 'cancelled'
export type CancelReason = 'sold_out' | 'payment_failed' | 'expired'

export interface TicketDto {
  id: string
  number: number
  status: 'valid' | 'used' | 'cancelled'
}

export interface OrderDto {
  id: string
  eventId: string
  quantity: number
  customerEmail: string
  status: OrderStatus
  cancelReason: CancelReason | null
  createdAt: string
  tickets: TicketDto[]
}

export type ProblemType =
  | 'sold_out'
  | 'event_started'
  | 'capacity_below_sold'
  | 'dependency_unavailable'
