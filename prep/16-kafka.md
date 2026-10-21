# Kafka & messaging

## Core model
- A **topic** is split into **partitions**: ordered, append-only logs. Each record has a key, value, headers, timestamp and an **offset** (its position in the partition).
- **Ordering is guaranteed only within a partition.** The default partitioner sends records with the same key to the same partition (`hash(key) % partitions`).
- Brokers form a cluster; each partition has a **leader** and followers (replication factor). **ISR** = in-sync replicas that are caught up with the leader.
- Cluster metadata is managed by **KRaft** (Kafka's own Raft quorum); Kafka 4.0 removed ZooKeeper.
- Records are **not deleted when consumed**: retention is by time or size. **Log compaction** keeps the latest record per key instead; a `null` value (tombstone) deletes the key.

## Producers
- `acks=0` (fire and forget), `acks=1` (leader wrote it), `acks=all` (all in-sync replicas). With `replication.factor=3` and `min.insync.replicas=2`, `acks=all` survives a broker loss without data loss.
- **Idempotent producer** (`enable.idempotence=true`, default since Kafka 3.0): retries don't create duplicates or reorder records within a partition, for the lifetime of the producer.
- Throughput: `linger.ms` (wait a bit to fill batches), `batch.size`, `compression.type` (lz4, zstd). `send()` is async; check the result through the callback or future.
- **Transactions** (`transactional.id`): atomic writes to several partitions plus the consumer offsets → exactly-once read-process-write inside Kafka.

## Consumers and consumer groups
- Within a **consumer group**, each partition is assigned to exactly one consumer. Parallelism is capped by the partition count: extra consumers sit idle.
- Different groups each receive **all** records (publish-subscribe).
- Offsets are committed to the internal `__consumer_offsets` topic. Auto-commit (`enable.auto.commit`, every 5 s by default) vs manual commit after processing.
- Commit **after** processing → at-least-once (duplicates after a crash). Commit **before** → at-most-once (loss after a crash).
- **Rebalance** when consumers join, leave or time out. Taking longer than `max.poll.interval.ms` between polls gets a consumer kicked out of the group. The cooperative sticky assignor and static membership (`group.instance.id`) reduce rebalance pain.
- `auto.offset.reset` (`earliest`/`latest`) applies only when a group has no committed offset.
- **Consumer lag** = log end offset - committed offset: the key health metric.

## Delivery semantics
- **At-most-once**, **at-least-once** (the practical default), **exactly-once**.
- Exactly-once holds for Kafka-to-Kafka processing (transactions + `isolation.level=read_committed`). With external systems (a database, an HTTP API) you get at-least-once plus **idempotent consumers**.
- Idempotent consumers: dedupe by event id (a processed-events table with a unique key), upserts, natural unique constraints, or the business state making the operation a no-op.

## Error handling
- Transient errors: retry with backoff. Permanent errors (invalid data): send to a **dead letter topic** (DLT) after N attempts, and alert.
- **Blocking retries** (retry in place) keep partition order but stall the partition; **non-blocking retries** (retry topics) keep the partition flowing but break ordering.
- **Poison pill**: a record that can't even be deserialized blocks the partition forever. Wrap the deserializer (`ErrorHandlingDeserializer` in Spring Kafka).
- Spring Kafka: `DefaultErrorHandler` + `DeadLetterPublishingRecoverer`, or `@RetryableTopic`.

## Design choices
- **Partition count**: target throughput / per-partition throughput, plus enough for consumer parallelism. It can be increased but never decreased, and increasing it changes the key → partition mapping (breaking per-key order across the change).
- **Key**: the entity id when per-entity order matters (`orderId`). Avoid hot keys. A `null` key spreads records (sticky partitioner).
- **Schemas**: Avro/Protobuf/JSON Schema with a Schema Registry; evolve with backward-compatible changes (add optional fields, never reuse or remove required ones).
- **Kafka vs RabbitMQ**: Kafka is a replayable log with retention, consumer-managed offsets, very high throughput and ordering per partition. RabbitMQ is a broker that pushes and deletes acknowledged messages, with flexible routing (exchanges), per-message TTL and priorities.

## Spring Kafka
- `KafkaTemplate.send()` returns a `CompletableFuture<SendResult>` (Spring Kafka 3.0+).
- `@KafkaListener(topics = "...", groupId = "...", concurrency = "3")`; batch listeners; container factories per configuration.
- Ack modes: `BATCH` (default: commit after each poll's records are processed), `RECORD`, `MANUAL`/`MANUAL_IMMEDIATE` with `Acknowledgment.acknowledge()`.
- Transactions with `KafkaTransactionManager`. A DB transaction and a Kafka transaction are **not** atomic together: use the outbox pattern for that.
