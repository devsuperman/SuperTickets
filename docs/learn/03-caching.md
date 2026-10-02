# Caching: cache-aside with Redis

**In one sentence:** a cache keeps a copy of hot, rarely-changing data in fast memory so most reads skip the database; SuperTickets uses Redis in the Catalog service with the cache-aside pattern, jittered TTLs, a version counter for list keys, and a rule that Redis may fail without taking the API down.

Previous: [02-api-gateway-and-load-balancer.md](02-api-gateway-and-load-balancer.md) · Next: [04-message-broker.md](04-message-broker.md)

## The problem

Friday 10:00, tickets for a big concert go on sale. Thousands of people refresh `GET /events`. Every request runs the same `SELECT ... ORDER BY starts_at LIMIT 100` against Postgres, and the answer is identical for all of them. Postgres CPU climbs, latency grows, and the checkout path (which shares nothing with the catalog, but shares your attention and your pager) is next. Worse, the data changes maybe twice a day when an admin edits an event.

Two follow-up failures bite the naive fix ("just cache it"):

- Everything cached at 10:00:00 with a 60 s TTL expires at 10:01:00 together, and the database takes the whole herd at once (a *cache stampede*).
- Redis restarts, and because the code assumed it was always there, every `GET /events` returns 500.

## The concept

**Cache-aside** (lazy loading): the application owns the cache logic.

```
read:   app -> cache ? hit  -> return
                     : miss -> DB -> put in cache (with TTL) -> return
write:  app -> DB -> invalidate cache entry
```

Key ideas:

- **TTL** bounds staleness: even if you forget to invalidate, data is at most N seconds old.
- **Jitter** randomises each TTL a little so entries written together do not expire together.
- **Invalidation** on write: delete what you changed. Deleting is easier than updating, and the next read repopulates.
- **List caches are hard to invalidate** (which of the keys contain this event? search results vary by query). A cheap trick is a **versioned key**: embed a counter in the key and bump the counter on write; old keys become unreachable and simply expire.
- **Graceful degradation**: the cache is an optimisation, never a dependency. A cache error is treated as a miss.

## How SuperTickets applies it

All cache logic lives in one class, [`EventCache`](../../src/Catalog.Api/Common/EventCache.cs), used directly by the feature handlers (no repository layer, see [01-microservices-and-vertical-slice.md](01-microservices-and-vertical-slice.md)).

| Key | Value | TTL |
|---|---|---|
| `catalog:event:{id}` | `EventDto` | `Cache__TtlSeconds` +/- 10 % |
| `catalog:v{version}:events:{search lowercased}` | `EventDto[]` | same |
| `catalog:version` | counter | none |

Source of truth: [contracts.md > Cache](../project/contracts.md#cache-catalog).

**Read path.** [`GetEvent.Handle`](../../src/Catalog.Api/Features/GetEvent/GetEvent.cs) calls `cache.GetEvent(id)`; a hit returns with `X-Cache: HIT`. A miss reads Postgres, calls `cache.SetEvent(dto)` and answers `X-Cache: MISS`. [`ListEvents.Handle`](../../src/Catalog.Api/Features/ListEvents/ListEvents.cs) does the same with `GetList`/`SetList`.

**TTL + jitter.** In `EventCache.Set`, `ttl = TtlSeconds * (0.9 + Random.Shared.NextDouble() * 0.2)`: 54 to 66 s for the default 60.

**Versioned list keys.** `EventCache.ListKey` reads `catalog:version` (missing means 0) and builds `catalog:v{version}:events:{search}`. Search text is lowercased so `Rock` and `rock` share an entry.

**Invalidation.** [`CreateEvent`](../../src/Catalog.Api/Features/CreateEvent/CreateEvent.cs) and [`UpdateEvent`](../../src/Catalog.Api/Features/UpdateEvent/UpdateEvent.cs) call `EventCache.Invalidate(id)` after `SaveChangesAsync`: `DEL catalog:event:{id}` plus `INCR catalog:version`. The order matters: write the database first, then invalidate, so a concurrent reader cannot re-cache the old row after you invalidated.

**Graceful degradation.** Every Redis call in `EventCache` (`Get`, `Set`, `ListKey`, `Invalidate`) is wrapped in try/catch that logs a warning and returns "miss". The handler then falls through to Postgres and sets `X-Cache: MISS`. The health check [`RedisCheck`](../../src/Catalog.Api/Common/HealthChecks.cs) reports Redis as *Degraded*, never *Unhealthy*, so the load balancer keeps the replica in rotation.

**Two replicas, one cache.** Catalog runs 2 replicas behind nginx ([02](02-api-gateway-and-load-balancer.md)). That is why the cache is in Redis and not in process memory: an in-memory cache would be invalidated on only one replica.

## Try it

```bash
docker compose up --build -d --wait

# First call is a MISS, repeats are HITs (see also X-Upstream: which replica answered)
curl -si http://localhost:8080/events | grep -iE "^(HTTP|x-cache|x-upstream)"
curl -si http://localhost:8080/events | grep -iE "^(HTTP|x-cache|x-upstream)"

# Peek inside Redis
docker compose exec redis redis-cli --scan --pattern 'catalog:*'
docker compose exec redis redis-cli GET catalog:version
docker compose exec redis redis-cli TTL "catalog:v0:events:"    # ~54-66, differs per write

# Invalidate: update an event as admin, then watch the version bump and a MISS
curl -s -X POST http://localhost:8080/admin/events -H 'X-Api-Key: dev-admin-key' -H 'Content-Type: application/json' \
  -d '{"name":"Cache Demo","venue":"Hall","startsAt":"2030-01-01T20:00:00Z","totalTickets":10,"price":9.90}'
docker compose exec redis redis-cli GET catalog:version
curl -si http://localhost:8080/events | grep -i x-cache      # MISS (new version key)

# Redis down: API keeps answering, always MISS
docker compose stop redis
curl -si http://localhost:8080/events | grep -iE "^(HTTP|x-cache)"   # 200, MISS
curl -s http://localhost:8080/events -o /dev/null -w '%{http_code}\n'
docker compose start redis
```

Change the TTL with `Cache__TtlSeconds` on `catalog-api` in `docker-compose.yml` (default `60`). The smoke test checks cache hits ([tech-plan.md > Definition of done](../project/tech-plan.md#definition-of-done)); tests live in [tests/Catalog.Api.Tests](../../tests/Catalog.Api.Tests/CatalogTests.cs).

## Trade-offs and what we did NOT do

- **Staleness window.** A cache failure during `Invalidate` is only logged, so a stale entry can live until its TTL (about 60 s). Acceptable for a catalog; not for stock counts, which is why availability is served by Inventory, never cached ([08](08-concurrency-and-inventory.md)).
- **Version keys leak.** Old `catalog:v{n}:*` keys are not deleted, they just expire by TTL.
- **No stampede protection beyond jitter.** No locks or request coalescing: a hot key expiring still lets several requests hit Postgres at once. Fine at this scale.
- **No negative caching** of 404s, no write-through, no cache warming, no Redis Cluster or Sentinel.
- **Whole lists cached**, not per-row composition: simple, but one edit invalidates every search.

See [09-resilience-patterns.md](09-resilience-patterns.md) for how this graceful degradation fits the other patterns.

## Check yourself

1. Why does `UpdateEvent` write Postgres before invalidating Redis?
2. What would happen to the list cache if `Invalidate` only deleted `catalog:event:{id}`?
3. Why add jitter to the TTL, and what does it not protect against?
4. Redis is down: what status code and `X-Cache` value does `GET /events` return, and does `/health` fail?

<details>
<summary>Answers</summary>

1. If it invalidated first, a reader could miss, read the old row, and re-cache it before the write commits; the stale value would then live a full TTL.
2. Lists would keep serving the old data until TTL, because their keys contain search text and are not known to `Invalidate`. Bumping `catalog:version` makes all old list keys unreachable at once.
3. It spreads expirations so keys written together do not all miss at the same instant. It does not stop several concurrent requests from missing the *same* key (no locking/coalescing).
4. 200 with `X-Cache: MISS` (Postgres answers). `/health` stays up: Redis is reported as Degraded, not Unhealthy.
</details>

## Further reading

- Cache-aside / "lazy loading" (Microsoft Azure Architecture Center, cloud design patterns)
- Cache stampede / "thundering herd" and probabilistic early expiration
- Redis documentation: `EXPIRE`, `INCR`, eviction policies
