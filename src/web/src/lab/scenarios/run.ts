import { createSim, type Action, type Sim, type SimEvent, type SimState } from '../engine'
import type { Scenario, Step } from './types'

export const stepActions = (step: Step, state: SimState): Action[] =>
  typeof step.actions === 'function' ? step.actions(state) : step.actions ?? []

/** Runs a whole scenario at once (tests); the UI plays the same steps on a clock. */
export function runScenario(scenario: Scenario): { sim: Sim; events: SimEvent[]; stepEvents: SimEvent[][] } {
  const sim = createSim(scenario.options)
  const stepEvents = scenario.steps.map((step) => {
    for (const a of stepActions(step, sim.state)) sim.dispatch(a)
    return sim.advance(step.runMs)
  })
  return { sim, events: stepEvents.flat(), stepEvents }
}
