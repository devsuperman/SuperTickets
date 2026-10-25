import { happyPath } from './01-happy-path'
import { cache } from './02-cache'
import { redisDown } from './03-redis-down'
import { loadBalancer } from './04-load-balancer'
import { lastTicket } from './05-last-ticket'
import { idempotency } from './06-idempotency'
import { paymentFailure } from './07-payment-failure'
import { inventorySlow } from './08-inventory-slow'
import { poisonMessage } from './09-poison-message'
import { workerCrash } from './10-worker-crash'
import { rabbitmqDown } from './11-rabbitmq-down'
import { duplicateDelivery } from './12-duplicate-delivery'
import { sandbox } from './sandbox'
import type { Scenario } from './types'

export const scenarios: Scenario[] = [
  happyPath, cache, redisDown, loadBalancer, lastTicket, idempotency,
  paymentFailure, inventorySlow, poisonMessage, workerCrash, rabbitmqDown, duplicateDelivery,
  sandbox,
]

export const findScenario = (slug: string | undefined) => scenarios.find((s) => s.slug === slug)

export { runScenario, stepActions } from './run'
export { EVENT_ID, adminUpdate, get, placeOrder, repoHref } from './common'
export type * from './types'
