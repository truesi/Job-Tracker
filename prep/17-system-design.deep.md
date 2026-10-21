# System design basics: deep dive

This page goes deeper on the short notes, section by section, with worked examples. For a senior backend role, interviewers care less about drawing boxes and more about trade-offs, failure handling and numbers.

## How to run the interview

### A 45-minute timeline
| Minutes | Step |
|---|---|
| 0–5 | Requirements: features, users, scale, latency, consistency needs. Write them down. |
| 5–10 | Estimates: QPS (average and peak), storage, bandwidth. |
| 10–15 | API (endpoints or messages) and data model (entities, keys, access patterns). |
| 15–25 | High-level design: walk one read and one write request through it. |
| 25–40 | Deep dives the interviewer picks: bottlenecks, scaling, failure modes. |
| 40–45 | Summary, trade-offs, what you'd do with more time. |

### A worked estimate: URL shortener
- 100M new links per month → ~40 writes/s average (100M / 2.6M s), say 400/s at peak.
- Read:write ratio 100:1 → ~4,000 redirects/s average, ~40,000/s peak.
- Storage: 500 bytes per link × 100M × 12 months × 5 years = 3 TB. Fits one sharded or even a large single database; easily fits in a key-value store.
- Hot set: 20% of links get 80% of traffic. Caching 20% of a day's active links fits in a few GB of Redis.

Conclusion stated out loud: "Read-heavy, small data, latency-sensitive redirects. Focus on the cache and on ID generation; the database is not the bottleneck."

Read more: [System Design Primer](https://github.com/donnemartin/system-design-primer) · [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832)

## Scaling building blocks

### The usual progression of a growing service
1. One server with the app and DB.
2. A separate DB server; a load balancer with several stateless app instances.
3. Cache (Redis) for hot reads; CDN for static assets.
4. Read replicas; async work moved to queues and workers.
5. Partitioning the big tables; splitting services along domain boundaries.
6. Sharding the write-heavy data; multi-region.
Saying where on this path the system is, and why the next step is needed, makes a strong answer.

### Cache invalidation, honestly
- **TTL only**: simple, bounded staleness. Often good enough.
- **Evict on write** (cache-aside): update the DB, then delete the cache key. Deleting is safer than updating the cache: two concurrent writers can put the cache entries in the wrong order.
- Still racy: a reader can load an old value from the DB and write it into the cache after the writer's delete. Short TTLs bound the damage; versioned values or CDC-driven invalidation (Debezium → evict) close the gap.
- **Negative caching**: cache "not found" briefly, so missing keys don't hit the DB each time (and as protection against enumeration).

### CQRS in practice
Write model: normalized tables with constraints and transactions. Read model: denormalized views (a search index, a precomputed JSON document per page) updated from events. Reads scale independently, at the cost of eventual consistency between the two.

Read more: [AWS: caching best practices](https://aws.amazon.com/caching/best-practices/) · [Martin Fowler: CQRS](https://martinfowler.com/bliki/CQRS.html)

## Reliability patterns

### Timeouts and retries, concretely
```yaml
resilience4j:
  circuitbreaker:
    instances:
      payments:
        sliding-window-size: 50
        failure-rate-threshold: 50          # open when 50% of the last 50 calls failed
        slow-call-duration-threshold: 2s
        wait-duration-in-open-state: 30s
        permitted-number-of-calls-in-half-open-state: 5
  retry:
    instances:
      payments:
        max-attempts: 3
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        enable-randomized-wait: true        # jitter
  timelimiter:
    instances:
      payments:
        timeout-duration: 3s
```
Set the timeout from the dependency's latency percentiles (a bit above its p99), and make sure the caller's own deadline is longer than all its retries combined.

### Idempotency keys, a table design
```sql
CREATE TABLE idempotency_keys (
    key          text PRIMARY KEY,
    request_hash text NOT NULL,              -- reject the same key with a different body
    status       text NOT NULL,              -- IN_PROGRESS / COMPLETED
    response     jsonb,
    created_at   timestamptz NOT NULL DEFAULT now()
);
```
Flow: insert the key (a conflict means a retry: return the stored response, or 409 if still in progress), do the work, store the response, all in the same transaction as the business change where possible. Expire keys after 24 hours or so.

### Graceful degradation examples
Recommendations down → show bestsellers from cache. Pricing service slow → serve the last known price with a "may change" note. Search down → fall back to a simple DB query with fewer features. Decide these with product people before the outage.

Read more: [AWS Builders' Library: timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) · [AWS Builders' Library: making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) · [Stripe: designing robust APIs with idempotency](https://stripe.com/blog/idempotency) · [Resilience4j documentation](https://resilience4j.readme.io/docs/circuitbreaker) · [Google SRE book: service level objectives](https://sre.google/sre-book/service-level-objectives/)

## Rate limiting

### Token bucket in Redis (atomic with Lua)
```lua
-- KEYS[1] = bucket key; ARGV = capacity, refill_per_sec, now_ms
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity
local ts = tonumber(bucket[2]) or now
tokens = math.min(capacity, tokens + (now - ts) / 1000 * rate)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000))
return allowed and 1 or 0
```
The whole read-modify-write runs atomically inside Redis, so concurrent API instances can't overspend tokens.

### Where to enforce
- At the edge (API gateway, Envoy, Nginx) for coarse protection per IP or API key.
- In the service for business limits (5 password resets per hour per account).
- Per downstream dependency (client-side limiting) to protect partners and quotas.

Read more: [Stripe: scaling your API with rate limiters](https://stripe.com/blog/rate-limiters) · [Cloudflare: how rate limiting works at scale](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)

## Data consistency in distributed systems

### Fencing tokens
```
Client A: acquire lock → token 33 → long GC pause ...... write(token 33) → rejected (storage saw 34)
Client B:                 lock expired → acquire → token 34 → write(token 34) → accepted
```
The protected storage remembers the highest token it has seen and rejects older ones. Without that check, no lock service can make the scenario safe.

### Choosing consistency per feature
| Feature | Acceptable consistency |
|---|---|
| Account balance, inventory reservation, unique usernames | strong (single leader, transactions, constraints) |
| Order status page | read-your-writes |
| Like counters, view counts, feeds | eventual |
| Search index, analytics | eventual, seconds to minutes |

Read more: [Martin Kleppmann: How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) · [Jepsen: consistency models](https://jepsen.io/consistency)

## API design

### REST conventions that come up
| Action | Request | Success |
|---|---|---|
| Create | `POST /orders` (+ `Idempotency-Key`) | `201 Created` + `Location` |
| Read | `GET /orders/42` | `200`, or `304` with `ETag`/`If-None-Match` |
| Replace | `PUT /orders/42` | `200`/`204` |
| Partial update | `PATCH /orders/42` with `If-Match` | `200`/`204`, or `412` on a version conflict |
| Delete | `DELETE /orders/42` | `204` (and `204`/`404` when repeated) |
| Long operation | `POST /reports` | `202 Accepted` + a status URL to poll |

### Cursor pagination response
```json
{
  "items": [ ... ],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNC0wNi0wMVQxMjowMDowMFoiLCJpZCI6NDJ9"
}
```
The cursor is an opaque, base64-encoded `(created_at, id)` of the last item; the server decodes it into a keyset `WHERE` clause.

### gRPC vs REST
gRPC: binary Protobuf, HTTP/2 multiplexing, generated clients, deadlines propagated across calls, bidirectional streaming. REST: universal tooling, browser-friendly, cacheable by HTTP intermediaries. A common split: REST/JSON at the edge, gRPC between internal services.

Read more: [RFC 9110: HTTP semantics, idempotent methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) · [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html) · [Google API design guide](https://cloud.google.com/apis/design)

## Classic problems

### URL shortener, the full sketch
- `POST /links {url}` → generate an id (Snowflake, or a DB sequence handed out in ranges per instance) → base62 encode → store `code → url` in a key-value store or a table with a primary key on `code`.
- `GET /{code}` → Redis cache → DB on a miss → `302 Location: url`. Publish click events to Kafka asynchronously for analytics; never make the redirect wait for analytics.
- Custom aliases: a unique constraint on `code`. Abuse: rate limits per user, URL scanning for malware.

### Payment system essentials
- An **idempotency key** for every external request; a **state machine** per payment (`CREATED → AUTHORIZED → CAPTURED / FAILED / REFUNDED`), with transitions validated.
- A **double-entry ledger**: each payment creates balanced entries (debit customer, credit merchant), never updated, only appended or reversed.
- **Reconciliation**: daily comparison of the ledger with the payment provider's settlement reports, with an alert on every mismatch.
- Calls to the provider happen outside DB transactions; the outbox and status polling/webhooks handle "we don't know if it succeeded".

### Chat, the parts interviewers probe
- Connection gateways holding WebSockets; a registry (Redis) of which gateway holds which user.
- Messages persisted first (partitioned by conversation id, ordered by a per-conversation sequence), then delivered; clients ack and request missing ranges after reconnecting.
- Group chats: fan out through the gateways; very large groups behave like the celebrity feed problem.

Read more: [ByteByteGo (Alex Xu): System Design Interview](https://bytebytego.com/) · [High Scalability: real architectures](http://highscalability.com/)

## Observability

### The three signals, connected
A trace id generated at the edge travels in headers (W3C `traceparent`) through every service and message. Logs include it, so from a slow trace you can jump to its logs; metrics with exemplars link a latency spike to example traces. With Spring Boot 3, Micrometer Tracing + the OpenTelemetry exporter wires this up mostly by configuration.

### Alerting on SLO burn rate
Instead of "error rate > 1% for 5 minutes", alert when the error budget burns too fast: for a 99.9% monthly SLO, burning at 14.4× the allowed rate for 1 hour consumes 2% of the month's budget. That's a page. A slow burn becomes a ticket. Fewer false alarms, and every page matters.

Read more: [Google SRE workbook: alerting on SLOs](https://sre.google/workbook/alerting-on-slos/) · [OpenTelemetry documentation](https://opentelemetry.io/docs/) · [Google SRE book](https://sre.google/sre-book/table-of-contents/)

## Sources
- Alex Xu, *System Design Interview*, volumes 1 and 2: the standard interview walkthroughs.
- Martin Kleppmann, *Designing Data-Intensive Applications*: the theory behind every trade-off above.
- [System Design Primer](https://github.com/donnemartin/system-design-primer): a free, broad overview with exercises.
- [AWS Builders' Library](https://aws.amazon.com/builders-library/): how Amazon handles retries, timeouts, load shedding and deployments.
- [Google SRE books](https://sre.google/books/): reliability, SLOs and on-call, free online.
