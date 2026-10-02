import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { listEvents } from '@/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

export default function EventList() {
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const { data, isPending, error } = useQuery({
    queryKey: ['events', search],
    queryFn: () => listEvents(search || undefined),
  })

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Events</h1>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setSearch(text.trim())
        }}
      >
        <Input
          value={text}
          maxLength={100}
          placeholder="Search by name or venue"
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit">Search</Button>
      </form>
      {isPending && <p className="text-muted-foreground">Loading...</p>}
      {error && <p className="text-destructive">Could not load events.</p>}
      {data?.length === 0 && <p className="text-muted-foreground">No events found.</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {data?.map((e) => (
          <Card key={e.id}>
            <CardHeader>
              <CardTitle>
                <Link to={`/event/${e.id}`} className="hover:underline">{e.name}</Link>
              </CardTitle>
              <CardDescription>
                {e.venue} · {new Date(e.startsAt).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center justify-between">
              <span className="font-medium">${e.price.toFixed(2)}</span>
              <Button asChild size="sm"><Link to={`/event/${e.id}`}>Details</Link></Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
