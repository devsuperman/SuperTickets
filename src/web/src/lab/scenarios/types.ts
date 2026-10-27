import type { Action, SimOptions, SimState } from '../engine'

/** A file in this repository; rendered as a GitHub link so it also works on the Pages build. */
export interface RepoLink {
  label: string
  path: string
}

export interface Step {
  title: string
  /** What the script does (or what the reader would type against the real stack). */
  do: string
  /** What to look at in the diagram and the inspector. */
  see: string
  /** The pattern behind it. */
  why: string
  /** Dispatched when the step starts; a function when the action needs ids created earlier (order id, outbox row). */
  actions?: Action[] | ((state: SimState) => Action[])
  /** Virtual ms the clock runs after the actions. */
  runMs: number
  /** A long wait (TTL, breaker, sweeper): played faster so it does not take minutes. */
  fastForward?: boolean
}

export interface Question {
  q: string
  a: string
}

/** One scenario of docs/project/lab-plan.md#scenarios (same numbering as docs/learn/case-studies.md). */
export interface Scenario {
  slug: string
  /** 0 = sandbox. */
  number: number
  title: string
  summary: string
  guides: RepoLink[]
  code: RepoLink[]
  /** Initial state: catalog + stock rows and toggles. No seed = the default seed. */
  options: SimOptions
  steps: Step[]
  questions: Question[]
}
