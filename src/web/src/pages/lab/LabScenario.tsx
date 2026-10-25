import { Link, useParams } from 'react-router'
import { ArchitectureDiagram } from '@/lab/components/ArchitectureDiagram'
import { Controls, RequestPanel } from '@/lab/components/Controls'
import { ExplainPanel } from '@/lab/components/ExplainPanel'
import { Inspector } from '@/lab/components/Inspector'
import { PlayerBar } from '@/lab/components/PlayerBar'
import { usePlayer } from '@/lab/components/usePlayer'
import { findScenario, type Scenario } from '@/lab/scenarios'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TooltipProvider } from '@/components/ui/tooltip'

function Playground({ scenario }: { scenario: Scenario }) {
  const player = usePlayer(scenario)
  const sandbox = scenario.steps.length === 0
  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <Link to="/lab" className="text-sm text-muted-foreground hover:underline">Lab</Link>
            <span className="text-muted-foreground">/</span>
            <h1 className="text-2xl font-semibold">
              {scenario.number > 0 && `${scenario.number}. `}{scenario.title}
            </h1>
          </div>
          <PlayerBar player={player} steps={scenario.steps.length} />
        </div>
        <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          <Card>
            <CardHeader><CardTitle>Architecture</CardTitle></CardHeader>
            <CardContent><ArchitectureDiagram state={player.state} log={player.log} /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Controls</CardTitle></CardHeader>
            <CardContent><Controls state={player.state} dispatch={player.dispatch} /></CardContent>
          </Card>
          <Card className="min-w-0">
            <CardHeader><CardTitle>Inspector</CardTitle></CardHeader>
            <CardContent>
              <Inspector state={player.state} changed={player.changed} log={player.log} onRedeliver={(id) => player.dispatch({ type: 'redeliver', messageId: id })} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{sandbox ? 'Send requests' : 'Explain'}</CardTitle></CardHeader>
            <CardContent>
              {sandbox
                ? <RequestPanel state={player.state} dispatch={player.dispatch} skip={player.skip} />
                : <ExplainPanel scenario={scenario} current={player.current} running={player.running} done={player.done} />}
            </CardContent>
          </Card>
        </div>
      </div>
    </TooltipProvider>
  )
}

export default function LabScenario() {
  const { scenario: slug } = useParams()
  const scenario = findScenario(slug)
  if (!scenario) {
    return (
      <div className="space-y-4">
        <p>There is no lab scenario called “{slug}”.</p>
        <Button asChild variant="outline"><Link to="/lab">All scenarios</Link></Button>
      </div>
    )
  }
  // key: a new scenario starts a fresh simulation.
  return <Playground key={scenario.slug} scenario={scenario} />
}
