import { Link } from 'react-router'
import { FlaskConical } from 'lucide-react'
import { scenarios } from '@/lab/scenarios'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function LabHome() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Lab</h1>
      <Alert>
        <FlaskConical />
        <AlertTitle>A simulation of SuperTickets, running in your browser</AlertTitle>
        <AlertDescription>
          Every service, database, cache and queue is modelled with the same rules and numbers as the real code, on a virtual clock.
          Nothing calls the real APIs. Pick a scenario to break something on purpose and watch each pattern respond, or open the sandbox.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {scenarios.map((s) => (
          <Link key={s.slug} to={`/lab/${s.slug}`} className="block">
            <Card className="h-full transition-colors hover:bg-accent">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Badge variant={s.number ? 'outline' : 'default'}>{s.number || 'free'}</Badge>
                  {s.title}
                </CardTitle>
                <CardDescription>{s.summary}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
