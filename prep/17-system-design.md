# System design basics

## How to run the interview
- **Clarify** functional requirements (what the system does) and non-functional ones (scale, latency, availability, consistency, durability, cost). Agree on what's out of scope.
- **Estimate**: users → requests per second (average and peak), storage per year, bandwidth. Round aggressively.
- **API** and **data model**, then a **high-level design** (clients, load balancer, services, storage, caches, queues).
- **Deep dive** into the hardest parts and bottlenecks; discuss **trade-offs** and **failure modes** (what if this component dies?).
- Drive the conversation and think aloud. There's no single right answer, only justified choices.
- Handy numbers: 1 day ≈ 86,400 s ≈ 10⁵ s, so 1M requests/day ≈ 12 rps. Memory access ~100 ns, SSD random read ~100 µs, round trip within a datacenter ~0.5 ms, across continents ~100–150 ms.

## Scaling building blocks
- **Vertical** scaling (a bigger machine) is simple but limited; **horizontal** (more machines) needs stateless services.
- **Stateless services** behind a load balancer: any instance serves any request. Sessions go to Redis or into tokens (JWT).
- **Load balancers**: L4 (TCP, by IP/port) or L7 (HTTP: route by path or header, TLS termination). Algorithms: round robin, least connections, consistent hashing (sticky by key).
- **Caching** layers: browser, CDN, reverse proxy, application cache (Redis), database buffer cache.
- Cache patterns: **cache-aside** (app reads the cache, on a miss reads the DB and fills the cache), read-through, write-through, write-behind. Invalidate by TTL plus explicit eviction on writes.
- **Cache stampede** (many misses at once on a hot key): request coalescing/locking, jittered TTLs, stale-while-revalidate.
- Databases: read replicas, partitioning, sharding; denormalization; **CQRS** (separate read models).
- **Queues** decouple services, absorb spikes, enable retries and async work.

## Reliability patterns
- **Timeouts** on every remote call. A call without a timeout can hold a thread forever.
- **Retries** with exponential backoff + **jitter**, a limited number of attempts, and only for idempotent operations.
- **Circuit breaker** (closed → open → half-open): stop calling a failing dependency and fail fast (Resilience4j).
- **Bulkhead**: separate thread pools or connection limits per dependency, so one slow dependency can't exhaust everything.
- **Rate limiting**, **load shedding**, **graceful degradation** (serve cached or partial results).
- **Idempotency keys** for unsafe operations (payments): store the key with the result and return the same result on a retry.
- Redundancy across availability zones, health checks and automatic failover, backups with *tested* restores.
- **SLI** (what you measure), **SLO** (the internal target, e.g. 99.9% of requests under 300 ms), **SLA** (the contract with penalties), error budgets.

## Rate limiting
- **Token bucket**: tokens refill at a fixed rate up to a capacity; each request takes one. Allows bursts, enforces an average rate.
- **Leaky bucket**: requests drain at a constant rate; smooths traffic.
- **Fixed window** counter: simple, but allows 2× the limit around window boundaries. **Sliding window** log or counter fixes that.
- Distributed limits: counters in Redis updated atomically (Lua script or `INCR` + `EXPIRE`).
- Respond with `429 Too Many Requests` and a `Retry-After` header. Limit by API key, user, or IP.

## Data consistency in distributed systems
- CAP/PACELC trade-offs; eventual consistency is acceptable for many read paths (feeds, counters) but not for money.
- Cross-service workflows: sagas, the transactional outbox, idempotent consumers.
- **Distributed locks** (Redis, ZooKeeper, a DB row) can expire while the holder is paused (GC, network), so protect the resource with **fencing tokens**. Leader election via etcd/ZooKeeper/Kubernetes leases.
- Unique IDs without coordination: UUIDv7, Snowflake.

## API design
- REST: resources as nouns, correct methods and status codes. **Idempotent** methods: GET, PUT, DELETE (and HEAD, OPTIONS); POST and PATCH are not.
- Pagination with **cursors** for large or changing collections; versioning (`/v1/` or headers); consistent errors (`application/problem+json`).
- **gRPC** for internal low-latency calls with strict contracts (HTTP/2, Protobuf, streaming); **GraphQL** when clients need flexible queries.
- Push to clients: polling, long polling, **SSE** (server → client), **WebSocket** (bidirectional). Webhooks for server-to-server notifications (sign and retry them).

## Classic problems
- **URL shortener**: base62 of a unique id (7 characters = 62⁷ ≈ 3.5 trillion), read-heavy so cache aggressively; 302 if you want click analytics, 301 lets browsers cache the redirect.
- **News feed**: fan-out on write (precomputed timelines, fast reads) vs fan-out on read (cheap writes); a hybrid for celebrities with millions of followers.
- **Chat**: WebSocket gateways, ordering per conversation, delivery receipts, presence, offline push notifications.
- **Payment system**: idempotency, double-entry ledger, a state machine per payment, reconciliation with the provider, no lost or double charges.
- Also common: rate limiter, notification service, distributed cache, file storage (object storage + metadata DB + CDN), job scheduler, search autocomplete (trie or prefix index), top-K (count-min sketch + heap).

## Observability
- **Logs** (structured JSON with a correlation/trace id), **metrics** (RED: Rate, Errors, Duration for services; USE: Utilization, Saturation, Errors for resources), **traces** (OpenTelemetry, distributed spans).
- Alert on symptoms users feel (SLO burn rate, error rate, latency), not on every cause (CPU at 80%).
- Dashboards per service; runbooks for every alert.
