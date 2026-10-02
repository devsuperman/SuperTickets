import { fetchJson } from './fetchJson'
import type {
  AvailabilityDto,
  CreateOrderRequest,
  EventDto,
  EventInput,
  OrderDto,
} from './types'

export * from './fetchJson'
export * from './types'

const adminHeaders = (apiKey: string) => ({ 'X-Api-Key': apiKey })

export const listEvents = (search?: string) =>
  fetchJson<EventDto[]>(`/events${search ? `?search=${encodeURIComponent(search)}` : ''}`)

export const getEvent = (id: string) => fetchJson<EventDto>(`/events/${id}`)

export const getAvailability = (id: string) =>
  fetchJson<AvailabilityDto>(`/events/${id}/availability`)

export const createOrder = (req: CreateOrderRequest, idempotencyKey: string) =>
  fetchJson<OrderDto>('/orders', {
    method: 'POST',
    body: req,
    headers: { 'Idempotency-Key': idempotencyKey },
  })

export const getOrder = (id: string) => fetchJson<OrderDto>(`/orders/${id}`)

export const createEvent = (input: EventInput, apiKey: string) =>
  fetchJson<EventDto>('/admin/events', { method: 'POST', body: input, headers: adminHeaders(apiKey) })

export const updateEvent = (id: string, input: EventInput, apiKey: string) =>
  fetchJson<EventDto>(`/admin/events/${id}`, { method: 'PUT', body: input, headers: adminHeaders(apiKey) })
