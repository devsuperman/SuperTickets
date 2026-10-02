import { useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { listEvents } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getApiKey, setApiKey } from './apiKey'

export default function EventManage() {
  const [key, setKey] = useState(getApiKey)
  const { data, isPending, error } = useQuery({ queryKey: ['events', ''], queryFn: () => listEvents() })

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold">Manage events</h1>
        <Button asChild><Link to="/manage/new">New event</Link></Button>
      </div>

      <div className="max-w-sm space-y-2">
        <Label htmlFor="apiKey">Admin API key</Label>
        <Input
          id="apiKey"
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            setApiKey(e.target.value)
          }}
        />
        <p className="text-sm text-muted-foreground">Kept in this browser tab only.</p>
      </div>

      {isPending && <p>Loading…</p>}
      {error && <p className="text-destructive">Could not load events.</p>}
      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Venue</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead className="text-right">Tickets</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{e.name}</TableCell>
                <TableCell>{e.venue}</TableCell>
                <TableCell>{new Date(e.startsAt).toLocaleString()}</TableCell>
                <TableCell className="text-right">{e.totalTickets}</TableCell>
                <TableCell className="text-right">{e.price.toFixed(2)}</TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="outline" size="sm"><Link to={`/manage/${e.id}`}>Edit</Link></Button>
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No upcoming events.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
