import { CheckCircle2, Circle, CircleDot, ExternalLink } from 'lucide-react'
import { repoHref, type RepoLink, type Scenario } from '../scenarios'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'

function Links({ title, links }: { title: string; links: RepoLink[] }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase text-muted-foreground">{title}</div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {links.map((l) => (
          <li key={l.path}>
            <a href={repoHref(l.path)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
              {l.label} <ExternalLink className="size-3" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Do / See / Why for each step; the running step is open. "Check yourself" at the end. */
export function ExplainPanel({ scenario, current, running, done }: { scenario: Scenario; current: number; running: boolean; done: boolean }) {
  const { steps, questions } = scenario
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{scenario.summary}</p>
      {steps.length > 0 && (
        <Accordion type="single" collapsible defaultValue={`step-${Math.max(0, current)}`} key={current}>
          {steps.map((s, i) => (
            <AccordionItem key={i} value={`step-${i}`}>
              <AccordionTrigger>
                <span className="flex items-center gap-2">
                  {i < current || (i === current && !running) ? <CheckCircle2 className="size-4 text-emerald-600" />
                    : i === current ? <CircleDot className="size-4 text-primary" /> : <Circle className="size-4 text-muted-foreground" />}
                  {i + 1}. {s.title}
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-2 text-sm">
                <p><span className="font-medium">Do:</span> {s.do}</p>
                <p><span className="font-medium">See:</span> {s.see}</p>
                <p><span className="font-medium">Why:</span> {s.why}</p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
      {done && (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Scenario complete</AlertTitle>
          <AlertDescription>Change a control and press Reset to try a variation, or answer the questions below.</AlertDescription>
        </Alert>
      )}
      {questions.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-medium">Check yourself</div>
          <Accordion type="multiple">
            {questions.map((q, i) => (
              <AccordionItem key={i} value={`q-${i}`}>
                <AccordionTrigger className="text-left">{q.q}</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">{q.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      )}
      <Separator />
      <Links title="Learn guides" links={scenario.guides} />
      <Links title="Code it mirrors" links={scenario.code} />
    </div>
  )
}
