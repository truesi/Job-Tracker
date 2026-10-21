# Partitioning, replication & sharding

## Partitioning
- Splits one large table into smaller **partitions** inside one database. PostgreSQL declarative partitioning (10+): `RANGE` (dates), `LIST` (region, tenant group), `HASH` (even spread).
- **Partition pruning**: the planner skips partitions that can't match the `WHERE`, so a query for last week touches one partition.
- Data retention becomes cheap: `DETACH`/`DROP` an old partition instead of a huge `DELETE` (no bloat, no long locks).
- Smaller per-partition indexes and faster maintenance (VACUUM, REINDEX per partition).
- Costs: queries without the partition key scan **all** partitions; primary keys and unique constraints must include the partition key; thousands of partitions slow planning; an update that changes the key moves the row.
- Pick the partition key from the dominant filter, usually time for events, logs and payments.

## Replication
- **Leader-follower** (primary-replica): all writes go to the leader and stream to replicas; replicas serve reads. Scales reads, not writes.
- **Asynchronous** replication: fast, but a failover can lose recently committed transactions, and replicas lag. **Synchronous**: no loss, but higher write latency, and writes stall if the sync replica is down.
- Replication lag breaks **read-your-writes**: a user saves, then reads from a stale replica. Fixes: read your own data from the leader for a while, sticky routing, or wait until the replica has replayed the write's LSN.
- PostgreSQL: **physical streaming** replication (WAL, the whole cluster, identical copies) and **logical** replication (row changes per table, across versions, selective). Failover is managed by tools like Patroni.
- Other topologies: multi-leader (writes in several regions, conflict resolution needed) and leaderless (Dynamo, Cassandra: quorums with `W + R > N`).

## Sharding
- **Horizontal** split across separate database servers: each shard holds a subset of the rows. It scales writes and storage beyond one machine.
- Not to be confused with **vertical** partitioning: splitting columns or tables (or whole domains into separate services and databases).
- **The shard key decides everything**: high cardinality, even load, and it must match the main access path (`tenant_id`, `user_id`) so most queries hit one shard.
- Strategies: **range** (keeps ranges together; a monotonic key creates a hot shard), **hash** (even spread; range queries hit every shard), **directory/lookup table** (flexible placement, one more hop), **geo** (data residency, latency).
- **Consistent hashing**: keys and nodes on a ring; adding a node moves only ~1/N of the keys. Virtual nodes even out the load. Naive `hash(key) % N` remaps almost everything when N changes.

## Problems with sharding
- Cross-shard queries and joins become scatter-gather; denormalize or co-locate related data on the same shard key.
- Cross-shard transactions need 2PC or sagas.
- Globally unique IDs: no shared auto-increment. Use Snowflake-style IDs (time + machine + sequence) or UUIDv7.
- Resharding and rebalancing as data grows; hot keys (a celebrity account) that one shard can't handle.
- Operations multiply: migrations, backups and monitoring on every shard.
- **Shard last**: first try indexes, query fixes, caching, read replicas, partitioning, a bigger machine, archiving old data.
- Tools: Citus (PostgreSQL), Vitess (MySQL); MongoDB, Cassandra and CockroachDB shard by design.

## CAP and consistency
- **CAP**: during a network partition, a system must choose between consistency (refuse some requests) and availability (answer, possibly stale).
- **PACELC**: if Partitioned, choose A or C; Else, choose Latency or Consistency. The "else" part matters more day to day.
- Consistency models from strong to weak: linearizable → sequential → causal → read-your-writes / monotonic reads → eventual.
