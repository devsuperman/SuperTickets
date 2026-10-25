import { EVENT_ID, code, get, guides, labEvent } from './common'
import type { Scenario } from './types'

const event = `/events/${EVENT_ID}`

export const redisDown: Scenario = {
  slug: 'redis-down',
  number: 3,
  title: 'Redis down',
  summary: 'Graceful degradation: with Redis stopped, Catalog serves every read from Postgres (always MISS) and reports degraded health.',
  guides: [guides.caching, guides.resilience],
  code: [code.eventCache, code.catalogProgram],
  options: { events: [labEvent(10)] },
  steps: [
    {
      title: 'Stop Redis',
      do: 'Toggle Redis off (docker compose stop redis).',
      see: 'The Redis node turns red and both Catalog replicas report health "degraded" instead of "healthy".',
      why: 'Health reflects a dependency that is down without taking the service out: Catalog still works, just slower.',
      actions: [{ type: 'setToggle', key: 'redisUp', value: false }],
      runMs: 100,
    },
    {
      title: 'Read an event',
      do: `GET ${event}`,
      see: 'The Redis GET fails fast (red hop), Catalog reads Postgres and answers 200 with X-Cache: MISS. The SET is skipped too.',
      why: 'The cache is optional. Catalog treats any Redis error as a miss (fail fast, no backlog), so an outage costs latency, not availability.',
      actions: [get(event, 'read-1')],
      runMs: 300,
    },
    {
      title: 'Read again: still MISS',
      do: `GET ${event} and GET /events`,
      see: 'Every read goes to Postgres; nothing is cached while Redis is down. The Cache keys tab stays empty.',
      why: 'Degraded mode means Postgres takes the full read load. That is fine at this scale; at higher scale this is where you would add rate limits or a local fallback.',
      actions: [get(event, 'read-2'), get('/events', 'list-1')],
      runMs: 300,
    },
    {
      title: 'Start Redis again',
      do: `Toggle Redis on, then GET ${event}`,
      see: 'Health is back to "healthy". The first read is a MISS that fills the cache.',
      why: 'No restart and no warm-up job: cache-aside refills on demand.',
      actions: [{ type: 'setToggle', key: 'redisUp', value: true }, get(event, 'read-3')],
      runMs: 200,
    },
    {
      title: 'Read once more: HIT',
      do: `GET ${event}`,
      see: 'X-Cache: HIT.',
      why: 'Back to normal without any manual step.',
      actions: [get(event, 'read-4')],
      runMs: 200,
    },
  ],
  questions: [
    { q: 'Why does Catalog not wait for Redis to come back before answering?', a: 'The source of truth is Postgres; the cache only saves work. Waiting would turn a cache outage into a Catalog outage.' },
    { q: 'An admin update happens while Redis is down. What can go stale, and for how long?', a: 'The DEL/INCR cannot run, so entries written before the outage may be served after Redis returns, until their TTL (about 60 s) expires.' },
    { q: 'Why is health "degraded" and not "unhealthy"?', a: 'Unhealthy would make the gateway or orchestrator pull a replica that can still serve requests correctly.' },
  ],
}
