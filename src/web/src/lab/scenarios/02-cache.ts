import { config } from '../engine'
import { EVENT_ID, adminUpdate, code, get, guides, labEvent } from './common'
import type { Scenario } from './types'

const event = `/events/${EVENT_ID}`

export const cache: Scenario = {
  slug: 'cache',
  number: 2,
  title: 'Cache hit, miss and invalidation',
  summary: 'Cache-aside in Catalog: MISS → HIT, an admin update drops the key and bumps catalog:version, the jittered TTL expires.',
  guides: [guides.caching],
  code: [code.eventCache, code.getEvent, code.listEvents, code.updateEvent],
  options: { events: [labEvent(10)] },
  steps: [
    {
      title: 'First read: MISS',
      do: `GET ${event}`,
      see: 'Catalog asks Redis (nil), reads Postgres, then SETs the key with a TTL. The response has X-Cache: MISS. Open the Cache keys tab: the key and its TTL countdown.',
      why: 'Cache-aside: the application reads the cache first and fills it on a miss. The cache never talks to the database itself.',
      actions: [get(event, 'read-1')],
      runMs: 200,
    },
    {
      title: 'Second read: HIT',
      do: `GET ${event} again`,
      see: 'One Redis GET, no SQL, X-Cache: HIT. It may be served by the other Catalog replica: the cache is shared, so the replica does not matter.',
      why: 'Redis is outside the replicas, so every replica sees the same entries. A per-process cache would miss once per replica and drift.',
      actions: [get(event, 'read-2')],
      runMs: 200,
    },
    {
      title: 'Admin update invalidates',
      do: `PUT /admin/events/${EVENT_ID} with price 30 (X-Api-Key)`,
      see: 'Catalog updates Postgres, then DEL catalog:event:{id} and INCR catalog:version. List keys now embed the new version, so old list entries are simply never read again.',
      why: 'Deleting one key is easy; finding every search result that contains the event is not. A version number in the list key invalidates all lists with one INCR, and the old keys expire on their own.',
      actions: [adminUpdate({ price: 30 }, 'update')],
      runMs: 200,
    },
    {
      title: 'Read after the update: MISS with the new price',
      do: `GET ${event}`,
      see: 'X-Cache: MISS and price 30: the next read refills the cache from Postgres.',
      why: 'Invalidate on write keeps readers from seeing a stale price for a full TTL.',
      actions: [get(event, 'read-3')],
      runMs: 200,
    },
    {
      title: 'Let the TTL run out',
      do: `Fast-forward ${(config.cacheTtlMs * (1 + config.cacheJitter)) / 1000} s.`,
      see: `Watch the TTL countdown in the Cache keys tab: ${config.cacheTtlMs / 1000} s ± ${config.cacheJitter * 100} %, a different value per write. The key disappears when it reaches 0.`,
      why: 'The TTL is the safety net if an invalidation is ever missed (for example while Redis was down). The jitter spreads expiries so many keys do not expire, and hit Postgres, at the same moment.',
      runMs: config.cacheTtlMs * (1 + config.cacheJitter) + 100,
      fastForward: true,
    },
    {
      title: 'Read after expiry: MISS',
      do: `GET ${event}`,
      see: 'X-Cache: MISS again, then a fresh SET with a new jittered TTL.',
      why: 'Expired entries behave exactly like missing ones.',
      actions: [get(event, 'read-4')],
      runMs: 200,
    },
  ],
  questions: [
    { q: 'Why bump catalog:version instead of deleting every list key?', a: 'List keys depend on the search text, so Catalog cannot know which ones contain the event. One INCR changes every list key name at once; old keys age out by TTL.' },
    { q: 'What does the ± 10 % TTL jitter protect against?', a: 'A stampede: entries written together would expire together and send a burst of identical queries to Postgres.' },
    { q: 'Two replicas serve the reads. Why is the second read still a HIT?', a: 'The cache lives in Redis, shared by both replicas, not in process memory.' },
  ],
}
