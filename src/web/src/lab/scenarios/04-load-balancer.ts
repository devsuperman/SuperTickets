import { config } from '../engine'
import { EVENT_ID, code, get, guides, labEvent } from './common'
import type { Scenario } from './types'

const { perSecond, burst } = config.rateLimit

export const loadBalancer: Scenario = {
  slug: 'load-balancer',
  number: 4,
  title: 'Load balancer and rate limit',
  summary: `nginx round-robins the two Catalog replicas (X-Upstream) and limits each client to ${perSecond} r/s with a burst of ${burst} (429).`,
  guides: [guides.gateway],
  code: [code.nginx],
  options: { events: [labEvent(10)] },
  steps: [
    {
      title: '20 reads',
      do: 'GET /events 20 times.',
      see: 'Open the Requests tab: X-Upstream alternates catalog-1 / catalog-2, 10 each. They are all X-Cache: MISS: the 20 reads run at the same time, before the first SET lands (a small cache stampede).',
      why: 'The gateway is the only entry point. Catalog is stateless (the cache is in Redis), so any replica can answer any request and nginx can simply rotate.',
      actions: Array.from({ length: 20 }, (_, i) => get('/events', `rr-${i + 1}`)),
      runMs: 500,
    },
    {
      title: 'Routing rules',
      do: `GET /events/${EVENT_ID}/availability and GET /inventory/reservations`,
      see: 'Availability goes straight to Inventory (X-Upstream: inventory). The internal /inventory route answers 404 at the gateway.',
      why: 'nginx matches the more specific availability location first. Internal service routes are not exposed to the browser at all.',
      actions: [get(`/events/${EVENT_ID}/availability`, 'availability'), get('/inventory/reservations', 'internal')],
      runMs: 2_500,
    },
    {
      title: 'Burst of 160',
      do: 'Send 160 GET /events at once.',
      see: `${burst + 1} answer 200, the other ${160 - burst - 1} get 429 from nginx without reaching Catalog. The chart in the Requests tab shows the split.`,
      why: `limit_req with burst=${burst} nodelay: one request plus ${burst} queued slots pass immediately, the rest are rejected. The bucket drains at ${perSecond} r/s.`,
      actions: [{ type: 'burst', count: 160, path: '/events' }],
      runMs: 1_000,
    },
    {
      title: 'Wait, then read',
      do: 'Wait 2 s, then GET /events.',
      see: 'The bucket has drained: 200 again.',
      why: 'Rate limiting protects the services from one noisy client without blocking it for long.',
      actions: [],
      runMs: 2_000,
    },
    {
      title: 'One more read',
      do: 'GET /events',
      see: '200.',
      why: 'Back under the limit.',
      actions: [get('/events', 'after')],
      runMs: 200,
    },
  ],
  questions: [
    { q: 'What makes round-robin safe for Catalog but not for a service that keeps sessions in memory?', a: 'Catalog keeps no per-client state; everything lives in Postgres and Redis. A stateful service would need sticky sessions or shared state.' },
    { q: 'Why does the 429 not show up in Catalog\'s logs?', a: 'nginx rejects it before proxying; the request never reaches a replica.' },
    { q: 'Why does the gateway hide /inventory?', a: 'Reserve and release are internal calls from Order and the Worker; exposing them would let a browser change stock directly.' },
  ],
}
