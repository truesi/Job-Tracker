# Partitioning, replication & sharding: deep dive

This page goes deeper on the short notes, section by section. Chapters 5 (replication) and 6 (partitioning) of Kleppmann's *Designing Data-Intensive Applications* are the classic reference; the engineering blogs linked below show how real companies did it.

## Partitioning

### PostgreSQL declarative partitioning
```sql
CREATE TABLE payments (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    created_at  timestamptz NOT NULL,
    customer_id bigint NOT NULL,
    amount      numeric(12, 2) NOT NULL,
    PRIMARY KEY (id, created_at)                 -- must include the partition key
) PARTITION BY RANGE (created_at);

CREATE TABLE payments_2024_06 PARTITION OF payments
    FOR VALUES FROM ('2024-06-01') TO ('2024-07-01');
CREATE TABLE payments_default PARTITION OF payments DEFAULT;   -- catches unexpected rows

CREATE INDEX ON payments (customer_id, created_at);   -- created on every partition
```
Partitions must be created ahead of time. Use the `pg_partman` extension or a scheduled job, and alert when the default partition starts receiving rows.

### Retention without pain
```sql
ALTER TABLE payments DETACH PARTITION payments_2022_01 CONCURRENTLY;   -- PG 14+
DROP TABLE payments_2022_01;        -- or archive it to cold storage first
```

### Pruning: plan time vs run time
With a literal (`WHERE created_at >= '2024-06-01'`) pruning happens when planning. With a parameter, PostgreSQL prunes at execution (EXPLAIN shows `Subplans Removed: N`). A condition the planner can't relate to the key prunes nothing: `WHERE date_trunc('month', created_at) = ...` scans everything.

### When partitioning isn't worth it
Below tens of millions of rows, a good index usually wins. Partitioning helps when there's a natural key that most queries filter by, and/or when bulk deletion of old data is a real need. Partitioning by `customer_id` hash just to "make it faster" often makes queries without the key slower.

Read more: [PostgreSQL: table partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) · [pg_partman](https://github.com/pgpartman/pg_partman)

## Replication

### How streaming replication works
The primary writes WAL; a replica connects, receives the WAL stream, and replays it, producing a byte-identical copy. Monitoring:
```sql
-- on the primary
SELECT client_addr, state, sent_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS bytes_behind, replay_lag
FROM pg_stat_replication;
```
`synchronous_commit` decides what a commit waits for: `off` (nothing), `local` (own WAL flush), `remote_write`, `on` (sync replica flushed), `remote_apply` (sync replica applied: read-your-writes on that replica).

### Read-your-writes in a Spring app
A routing `DataSource` sends `@Transactional(readOnly = true)` to replicas and everything else to the primary. To avoid stale reads after a write: keep the next request of that user on the primary for a few seconds (a flag in the session or a cookie with the time of the last write), or pass the commit LSN and wait until the replica's `pg_last_wal_replay_lsn()` reaches it.

### Failover is the hard part
Detecting a dead primary, promoting the most up-to-date replica, repointing clients, and fencing the old primary so it can't accept writes (split brain). Use proven tooling (Patroni with etcd/Consul, or a managed service), not a homemade script. With async replication, decide in advance how much data loss is acceptable (RPO) and how long recovery may take (RTO).

### Logical replication
```sql
-- source
CREATE PUBLICATION orders_pub FOR TABLE orders, order_items;
-- target (can be a newer PostgreSQL major version)
CREATE SUBSCRIPTION orders_sub CONNECTION 'host=... dbname=shop' PUBLICATION orders_pub;
```
Typical uses: near-zero-downtime major version upgrades, moving tables to another database (a first step when splitting a monolith's DB), and feeding analytics. CDC tools like Debezium read the same logical decoding stream.

Read more: [PostgreSQL: high availability and replication](https://www.postgresql.org/docs/current/high-availability.html) · [PostgreSQL: logical replication](https://www.postgresql.org/docs/current/logical-replication.html) · [Patroni](https://github.com/patroni/patroni)

## Sharding

### Choosing a shard key: questions to ask
1. What do 90% of queries filter by? That's the candidate (`tenant_id` in B2B SaaS, `user_id` in consumer apps).
2. Is it high-cardinality and evenly loaded? Many small tenants are fine; one tenant with 40% of the traffic isn't (give big tenants dedicated shards).
3. Does it ever change? A key that changes means moving data between shards.
4. Which queries become cross-shard? Admin reports and analytics usually move to a separate store (a warehouse fed by CDC).

### Logical shards
Instead of mapping keys straight to servers, map them to a large fixed number of **logical shards** (say 4096, via `hash(key) % 4096`), and logical shards to physical databases through a small mapping table. Growing means moving whole logical shards to new servers, without rehashing any key. Instagram, Notion and Figma all describe variants of this.

### Consistent hashing in detail
Place each node at several pseudo-random points on a ring of hash values (**virtual nodes**). A key belongs to the first node clockwise from its hash. With 100+ virtual nodes per server the load evens out, and a joining server takes a little from many others instead of a lot from one neighbor. Cassandra, DynamoDB and many caches (Memcached clients, Envoy's ring hash) use this.

### Snowflake IDs
```
| 41 bits: ms since custom epoch | 10 bits: machine id | 12 bits: sequence |
```
That's 4096 IDs per millisecond per machine for ~69 years, sortable by time, generated locally. UUIDv7 gives similar time ordering in 128 bits without needing to assign machine IDs.

Read more: [Consistent hashing](https://en.wikipedia.org/wiki/Consistent_hashing) · [Amazon Dynamo paper (2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) · [Snowflake ID](https://en.wikipedia.org/wiki/Snowflake_ID)

## Problems with sharding

### Real-world sharding stories
- **Notion** split its PostgreSQL monolith into 480 logical shards on 32 physical databases, keyed by workspace ID, with a double-write and backfill migration.
- **Figma** chose horizontal sharding of PostgreSQL with its own proxy layer that parses queries and routes them by shard key.
Both are worth reading for the migration strategies: double writes, shadow reads and comparison, then cutover.

### The migration pattern
1. Start writing to both the old and new locations (or replicate with logical replication / CDC).
2. Backfill historical data.
3. Verify: compare reads from both (shadow reads).
4. Switch reads, then writes, behind a feature flag.
5. Keep the old path for rollback for a while, then remove it.

### Cross-shard operations
- **Queries**: scatter to all shards and merge (sort, limit, aggregate) in a proxy or the application. Latency is set by the slowest shard.
- **Transactions**: avoid them by design (keep each business transaction inside one shard key). Otherwise use sagas.
- **Unique constraints** across shards (a unique email) need a separate global lookup table, or routing by that value.

Read more: [Notion: sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion) · [Figma: horizontal sharding](https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/) · [Citus documentation](https://docs.citusdata.com/en/stable/) · [Vitess documentation](https://vitess.io/docs/)

## CAP and consistency

### CAP, stated precisely
CAP's "consistency" means **linearizability** (every read sees the latest write, as if there were one copy), and "availability" means every request to a non-failed node gets a response. It says nothing about latency or about systems without partitions, which is why PACELC is more useful for real design discussions. Also, "AP vs CP" is often a per-operation choice (Cassandra's consistency level per query).

### Consistency models cheat sheet
| Model | Guarantee | Example |
|---|---|---|
| Linearizable | one global up-to-date order | etcd, ZooKeeper writes, Spanner |
| Sequential | one order for all, maybe stale | rarely offered on its own; ZooKeeper reads (without sync) |
| Causal | cause before effect for everyone | a reply is never seen before its question |
| Read-your-writes | you see your own writes | profile edit visible after reload |
| Monotonic reads | you never go back in time | no flip-flopping between replicas |
| Eventual | replicas converge if writes stop | DNS, async replicas |

Read more: [Jepsen: consistency models](https://jepsen.io/consistency) · [CAP theorem](https://en.wikipedia.org/wiki/CAP_theorem) · [PACELC](https://en.wikipedia.org/wiki/PACELC_design_principle)

## Sources
- Martin Kleppmann, *Designing Data-Intensive Applications*, chapters 5, 6 and 9.
- [PostgreSQL documentation: partitioning and replication](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [Amazon Dynamo paper](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): consistent hashing, quorums and eventual consistency in one paper.
- Engineering blogs: Notion and Figma (linked above), and Instagram's "Sharding & IDs at Instagram" post.
