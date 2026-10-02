import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { ApiError, createEvent, getEvent, updateEvent, type EventInput } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { getApiKey } from './apiKey'

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  venue: z.string().trim().min(1, 'Venue is required').max(200),
  startsAt: z.string().min(1, 'Start date is required').refine((v) => new Date(v).getTime() > Date.now(), 'Start must be in the future'),
  totalTickets: z.coerce.number().int('Whole number').min(1, 'At least 1'),
  price: z.coerce.number().min(0, 'Cannot be negative'),
})
type Values = z.input<typeof schema>

const empty: Values = { name: '', venue: '', startsAt: '', totalTickets: 100, price: 0 }

// ISO UTC <-> datetime-local (browser local time)
const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

const messages: Record<string, string> = {
  event_started: 'This event has already started and can no longer be edited.',
  capacity_below_sold: 'Total tickets cannot be below the tickets already reserved or sold.',
}

export default function EventForm() {
  const { id } = useParams()
  const editing = id !== undefined
  const navigate = useNavigate()
  const qc = useQueryClient()
  const form = useForm<Values, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: empty,
  })

  const { data: event, isPending, error } = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: editing,
  })

  useEffect(() => {
    if (event) form.reset({ ...event, startsAt: toLocalInput(event.startsAt) })
  }, [event, form])

  const save = useMutation({
    mutationFn: (v: z.output<typeof schema>) => {
      const input: EventInput = { ...v, startsAt: new Date(v.startsAt).toISOString() }
      const key = getApiKey()
      return editing ? updateEvent(id, input, key) : createEvent(input, key)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events'] })
      qc.invalidateQueries({ queryKey: ['event'] })
      toast.success(editing ? 'Event updated' : 'Event created')
      navigate('/manage')
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) return toast.error('Something went wrong')
      const { status, problem } = err
      if (status === 401) return toast.error('Invalid admin API key. Set it on the Manage page.')
      if (status === 400 && problem.errors) {
        for (const [field, msgs] of Object.entries(problem.errors)) {
          const name = field.charAt(0).toLowerCase() + field.slice(1)
          if (name in empty) form.setError(name as keyof Values, { message: msgs.join(' ') })
        }
        return toast.error('Please fix the highlighted fields')
      }
      if (problem.type && messages[problem.type]) {
        if (problem.type === 'capacity_below_sold') form.setError('totalTickets', { message: messages[problem.type] })
        return toast.error(messages[problem.type])
      }
      toast.error(status === 503 ? 'Service unavailable, try again shortly' : err.message)
    },
  })

  if (editing && isPending) return <p>Loading…</p>
  if (editing && error) return <p className="text-destructive">Event not found.</p>

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">{editing ? 'Edit event' : 'New event'}</h1>
      <Form {...form}>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4">
          <FormField control={form.control} name="name" render={({ field }) => (
            <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="venue" render={({ field }) => (
            <FormItem><FormLabel>Venue</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="startsAt" render={({ field }) => (
            <FormItem><FormLabel>Starts at</FormLabel><FormControl><Input type="datetime-local" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="totalTickets" render={({ field }) => (
            <FormItem><FormLabel>Total tickets</FormLabel><FormControl><Input type="number" min={1} step={1} {...field} value={field.value as number} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="price" render={({ field }) => (
            <FormItem><FormLabel>Price</FormLabel><FormControl><Input type="number" min={0} step="0.01" {...field} value={field.value as number} /></FormControl><FormMessage /></FormItem>
          )} />
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="outline" onClick={() => navigate('/manage')}>Cancel</Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
