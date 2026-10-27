import type { ReactNode } from 'react'
import { Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { seconds } from './format'
import { SPEEDS, type Player } from './usePlayer'

function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

/** Run / Pause / Step / Reset, speed and the virtual clock. */
export function PlayerBar({ player, steps }: { player: Player; steps: number }) {
  const { playing, done, current, running } = player
  const finished = current + (running ? 0 : 1)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {playing ? (
        <Tip text="Pause the clock"><Button size="sm" variant="outline" onClick={player.pause}><Pause /> Pause</Button></Tip>
      ) : (
        <Tip text={steps ? 'Play every remaining step' : 'Start the clock'}>
          <Button size="sm" onClick={player.run} disabled={done}><Play /> Run</Button>
        </Tip>
      )}
      {steps > 0 && (
        <Tip text="Play until the end of the next step">
          <Button size="sm" variant="outline" onClick={player.step} disabled={playing || done}><StepForward /> Step</Button>
        </Tip>
      )}
      <Tip text="Start over from the initial state">
        <Button size="sm" variant="outline" onClick={player.reset}><RotateCcw /> Reset</Button>
      </Tip>
      <div className="flex w-40 items-center gap-2 text-sm">
        <span className="text-muted-foreground">Speed</span>
        <Slider
          aria-label="Speed" min={0} max={SPEEDS.length - 1} step={1} value={[player.speed]}
          onValueChange={([v]) => player.setSpeed(v)}
        />
        <span className="w-10 tabular-nums">×{SPEEDS[player.speed]}</span>
      </div>
      <span className="font-mono text-sm tabular-nums text-muted-foreground">t = {seconds(player.state.now)}</span>
      {steps > 0 && (
        <div className="flex min-w-32 flex-1 items-center gap-2 text-sm text-muted-foreground">
          <Progress value={(finished / steps) * 100} />
          <span className="shrink-0">{finished}/{steps}</span>
        </div>
      )}
    </div>
  )
}
