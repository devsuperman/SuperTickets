# API Gateway and Load Balancer

**In one sentence:** One nginx container is the only door into SuperTickets: it routes paths to the right service (gateway), rate-limits callers, hides internal routes, and spreads `/events` traffic across two Catalog replicas (load balancer), which only works because Catalog keeps no state in memory.

## The problem

The SPA needs to call four services. If it talks to each directly, browsers need every address and CORS rule, internal endpoints like `PUT /inventory/events/{id}` are one `curl` away from the internet, and one misbehaving client can hammer a service until it falls over. And when Catalog gets popular, one process is all there is.

## The concept

- **Reverse proxy**: sits in front of servers and forwards client requests to them.
- **API gateway**: a reverse proxy with API concerns: routing by path, auth, rate limiting, hiding internals.
- **Load balancer**: spreads requests over several identical instances. nginx does both jobs here.

```
Browser ─▶ gateway:8080 ─┬─ /events/{id}/availability ─▶ inventory-api
                         ├─ /events, /admin ───────────▶ catalog-api  (replica 1 | replica 2)
                         ├─ /orders ───────────────────▶ order-api
                         ├─ /inventory ─▶ 404
                         └─ everything else ───────────▶ web (SPA)
```

**L4 vs L7.** An L4 balancer forwards TCP connections without looking inside; fast but blind to paths. An L7 balancer (nginx `proxy_pass` over HTTP) reads the request, so it can route by path, add headers and rate-limit. We need L7.

**Algorithms:** round-robin (take turns; what we use), least connections (good for uneven request cost), IP hash/consistent hash (same client, same backend).
**Health:** a balancer should stop sending traffic to dead instances (active checks, or passive ones like nginx marking failures).
**Sticky sessions** pin a client to one instance because the instance holds session state. It limits scaling and failover, so the better answer is *stateless services*: any replica can answer any request.

## How SuperTickets applies it

Config: [infra/nginx/nginx.conf](../../infra/nginx/nginx.conf); routing table: [contracts.md › Routing](../project/contracts.md#routing).

**Routing order.** nginx prefers a matching regex `location` over a plain prefix one, which is why the availability route wins over `location /events`:

```nginx
location ~ ^/events/[^/]+/availability$ { ... proxy_pass http://inventory; }  # Inventory
location /events { ... proxy_pass http://catalog; }                            # Catalog
```

Without that regex, `/events/{id}/availability` would hit Catalog and 404. `/admin` goes to Catalog, `/orders` to Order, anything else falls to `location /` (the Vite SPA, with websocket upgrade headers for HMR).

**`/inventory` is a 404.** `location /inventory { return 404; }` makes the internal API (reserve/release/set capacity) unreachable from outside. Services still call each other directly on the Compose network via `Services__InventoryUrl`.

**Rate limit.** `limit_req_zone $binary_remote_addr zone=api:10m rate=50r/s;` keys by client IP; each location adds `limit_req zone=api burst=100 nodelay;`. Requests above 50/s are allowed to burst by 100 extra, then rejected with `limit_req_status 429`.

**Round-robin via Docker DNS.** The Catalog service has two replicas (`deploy: { replicas: 2 }` in [docker-compose.yml](../../docker-compose.yml)). Docker's embedded DNS returns both IPs for `catalog-api`:

```nginx
resolver 127.0.0.11 valid=5s ipv6=off;
upstream catalog { zone catalog 64k; server catalog-api:8080 resolve; }
```

`resolve` (with a shared-memory `zone`) makes nginx re-resolve every 5 s and treat each IP as a separate server, round-robin by default. Replicas can come and go without editing the file.

**`X-Upstream`.** `add_header X-Upstream $upstream_addr always;` shows which backend answered, so you can *see* the balancing. The gateway also forwards `X-Correlation-Id` ([10](10-observability-and-testing.md)).

**Why Catalog can scale.** [Catalog.Api](../../src/Catalog.Api/Program.cs) holds no per-user state: data is in Postgres, the cache is in Redis (shared by both replicas, see [03](03-caching.md)), and admin auth is a stateless `X-Api-Key` header ([AdminKeyFilter.cs](../../src/Catalog.Api/Common/AdminKeyFilter.cs)). That is why no sticky sessions are needed. Order, Inventory and Worker run as one instance each.

## Try it

```bash
docker compose up --build -d --wait
# round-robin: expect two different X-Upstream values
ID=$(curl -s localhost:8080/events | jq -r '.[0].id')
for i in $(seq 1 6); do curl -sI localhost:8080/events/$ID | grep -i -E 'x-upstream|x-cache'; done
# hidden internal route and the availability exception
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/inventory/events/$ID        # 404
curl -s localhost:8080/events/$ID/availability                                       # served by Inventory
# scale up/down (DNS refreshes within ~5 s)
docker compose up -d --no-recreate --scale catalog-api=3
docker compose stop $(docker compose ps -q catalog-api | head -1)
# rate limit: 200 quick requests, expect some 429
seq 200 | xargs -P 50 -I{} curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/events | sort | uniq -c
```

## Trade-offs and what we did NOT do

- The gateway is a single point of failure; production runs several behind a cloud or anycast balancer.
- No auth at the gateway (admin uses a shared API key checked in Catalog); no TLS, caching or request transformation.
- Rate limit is per client IP and per nginx instance; behind NAT many users share one budget.
- Passive health only: open-source nginx has no active health checks, so a dead replica may cost a failed request until DNS drops it.
- Only Catalog is replicated; no sticky sessions, no L4 balancing, no service discovery beyond Docker DNS.

## Check yourself

1. Why does `/events/{id}/availability` reach Inventory even though `/events` points at Catalog?
2. What does `resolve` change versus a plain `server catalog-api:8080;`?
3. Burst is 100 and rate 50 rps: what does the 151st request in one instant get?
4. Why would in-memory sessions in Catalog break round-robin?

<details><summary>Answers</summary>

1. nginx picks the matching regex location over a plain prefix location.
2. A plain name is resolved once at startup (one IP, stale later); `resolve` re-checks DNS and tracks every replica IP.
3. A `429`: it exceeds the 50/s rate plus 100 burst slots.
4. A user's next request may land on a replica that lacks their session, forcing sticky sessions or shared storage.
</details>

## Further reading

- nginx docs: `ngx_http_upstream_module`, `limit_req`
- "L4 vs L7 load balancing" (HAProxy, AWS ELB vs ALB docs)
- Sam Newman, "API Gateway" and "Backend for Frontend" patterns

Prev: [01](01-microservices-and-vertical-slice.md) · Next: [03 Caching](03-caching.md)
