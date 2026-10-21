# Kafka & messaging: deep dive

This page goes deeper on the short notes, section by section. The design section of the official Kafka documentation explains *why* Kafka works the way it does, and is short enough to read in one sitting.

## Core model

### Why a log is fast
- Writes are sequential appends to segment files, and reads are mostly sequential too. Disks and the OS page cache are very good at that.
- Kafka relies on the **page cache** instead of its own cache, and uses **zero-copy** (`sendfile`) to send data from the page cache to the network socket without copying through the JVM.
- Records are batched end to end: the producer sends batches, the broker stores them as is, and the consumer fetches them in batches.

### Storage layout
```
orders-0/                        partition 0 of topic "orders"
  00000000000000000000.log       segment: records
  00000000000000000000.index     offset -> position in the segment
  00000000000000000000.timeindex timestamp -> offset
  00000000000004500123.log       the next segment, named by its first offset
```
Retention and compaction work on whole segments; the active (last) segment is never deleted or compacted.

### Replication and leader election
Producers and consumers talk to the partition **leader** (consumers can fetch from a nearby follower with rack awareness). Followers fetch from the leader like consumers. The **high watermark** is the offset up to which all ISR members have replicated; consumers only see records below it, so they never read something that could disappear on a leader change.

`unclean.leader.election.enable=false` (the default) means an out-of-sync replica never becomes leader: the partition is unavailable instead of losing data. A classic CAP choice.

Read more: [Kafka documentation: design](https://kafka.apache.org/43/design/design/) · [Kafka documentation: replication](https://kafka.apache.org/43/design/design/#replication) · [Kafka documentation: log compaction](https://kafka.apache.org/43/design/design/#log-compaction)

## Producers

### Reliable producer settings
```properties
acks=all
enable.idempotence=true                 # default since 3.0
max.in.flight.requests.per.connection=5 # max allowed with idempotence; order is still kept
retries=2147483647                      # retry until...
delivery.timeout.ms=120000              # ...this overall deadline
linger.ms=5
compression.type=zstd
```
Topic side: `replication.factor=3`, `min.insync.replicas=2`.

### What idempotence actually does
Each producer gets a producer id; each batch per partition carries a sequence number. The broker rejects a batch whose sequence it has already written (a retry after a lost ack) and detects gaps. That removes duplicates from **retries**, but not duplicates from your application calling `send()` twice, or from a restarted producer (a new producer id), unless you use transactions with a stable `transactional.id`.

### Transactions
```java
producer.initTransactions();
while (running) {
    ConsumerRecords<String, Order> records = consumer.poll(Duration.ofMillis(200));
    producer.beginTransaction();
    for (var r : records) {
        producer.send(new ProducerRecord<>("invoices", r.key(), toInvoice(r.value())));
    }
    producer.sendOffsetsToTransaction(nextOffsets(records), consumer.groupMetadata());
    producer.commitTransaction();          // outputs + input offsets, atomically
}
```
A **zombie** (an old instance with the same `transactional.id`, still running after a pause) is fenced off by an epoch number: its commits fail.

Read more: [Kafka documentation: producer configs](https://kafka.apache.org/43/configuration/producer-configs/) · [Confluent: exactly-once semantics in Kafka](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)

## Consumers and consumer groups

### The poll loop
```java
try (var consumer = new KafkaConsumer<String, Order>(props)) {
    consumer.subscribe(List.of("orders"));
    while (running) {
        var records = consumer.poll(Duration.ofMillis(500));   // also sends heartbeats and handles rebalances
        for (var r : records) {
            process(r);
        }
        consumer.commitSync();                                // after processing: at-least-once
    }
}
```
A `KafkaConsumer` is **not thread-safe**. Scale by adding consumers (up to the partition count), or hand records to a worker pool while carefully tracking which offsets are safe to commit.

### Rebalancing
- **Eager** protocol (old default): all consumers stop and give up all partitions, then get a new assignment. Everything pauses.
- **Cooperative** (incremental): only the partitions that move are revoked. Use `CooperativeStickyAssignor` (and in Kafka 4.0 the new server-side consumer group protocol, KIP-848, makes rebalances incremental and broker-driven).
- **Static membership**: with `group.instance.id`, a restarting consumer (a rolling deploy) gets its partitions back without a rebalance, if it returns within `session.timeout.ms`.
- Heartbeats (`session.timeout.ms`) detect a dead process; `max.poll.interval.ms` detects a stuck one.

### Lag monitoring
Lag in records is easy to get, but **time lag** (how old the oldest unprocessed record is) is what users feel. Alert on lag that keeps growing, not on a fixed number: a spike that drains quickly is normal.

Read more: [Kafka documentation: consumer configs](https://kafka.apache.org/43/configuration/consumer-configs/) · [KIP-848: the next-gen consumer rebalance protocol](https://cwiki.apache.org/confluence/display/KAFKA/KIP-848%3A+The+Next+Generation+of+the+Consumer+Rebalance+Protocol)

## Delivery semantics

### Where duplicates come from
1. A producer retry after a lost ack (fixed by the idempotent producer).
2. A consumer crash between processing and committing.
3. A rebalance while processing: the partition moves and the new owner starts from the last committed offset.
4. Upstream services publishing the same event twice (the outbox relay is at-least-once too).

So design consumers to be idempotent, always.

### Idempotent consumer with a dedupe table
```java
@KafkaListener(topics = "payments")
@Transactional
public void on(PaymentReceived event) {
    int inserted = jdbc.update(
        "INSERT INTO processed_events (event_id) VALUES (?) ON CONFLICT DO NOTHING", event.id());
    if (inserted == 0) return;                // already processed
    orders.markPaid(event.orderId());         // same DB transaction as the dedupe row
}
```
The offset is committed after the method returns. A crash before the commit redelivers the event, and the dedupe row makes the second run a no-op.

Read more: [Kafka documentation: message delivery semantics](https://kafka.apache.org/43/design/design/#message-delivery-semantics) · [microservices.io: idempotent consumer](https://microservices.io/patterns/communication-style/idempotent-consumer.html)

## Error handling

### Spring Kafka: blocking retries, then a DLT
```java
@Bean
DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> template) {
    var recoverer = new DeadLetterPublishingRecoverer(template);       // -> "<topic>.DLT" by default
    var backoff = new ExponentialBackOffWithMaxRetries(4);
    backoff.setInitialInterval(500);
    backoff.setMultiplier(2.0);
    var handler = new DefaultErrorHandler(recoverer, backoff);
    handler.addNotRetryableExceptions(ValidationException.class);      // straight to DLT
    return handler;
}
```

### Non-blocking retries
```java
@RetryableTopic(attempts = "4", backoff = @Backoff(delay = 1000, multiplier = 2))
@KafkaListener(topics = "emails")
void send(EmailRequest req) { mailer.send(req); }

@DltHandler
void failed(EmailRequest req, @Header(KafkaHeaders.EXCEPTION_MESSAGE) String error) { ... }
```
Spring creates retry topics (`emails-retry-...`) consumed with a delay, plus `emails-dlt`, and the main topic keeps flowing.

### Choosing
| Situation | Strategy |
|---|---|
| Strict per-key order (balances, state changes) | blocking retries; on final failure, DLT and maybe pause the partition |
| Independent events (emails, notifications) | non-blocking retry topics |
| Bad data (validation, deserialization) | no retries, straight to DLT |

Read more: [Spring Kafka: handling exceptions](https://docs.spring.io/spring-kafka/reference/kafka/annotation-error-handling.html) · [Spring Kafka: non-blocking retries](https://docs.spring.io/spring-kafka/reference/retrytopic.html)

## Design choices

### Sizing partitions
- Measure the throughput of one partition for your producer and consumer (say 10 MB/s produce, 5 MB/s consume). For a target of 100 MB/s you need at least 20 partitions.
- Plan for growth, since you can't reduce partitions and adding them reshuffles keys.
- Don't overdo it: each partition costs open files, memory and leader elections. Thousands per broker are fine with KRaft, but not without limit.

### Event design
- **Events** state facts in the past tense (`OrderPlaced`), commands are requests (`ChargeCard`). Prefer events between services.
- **Thin events** (ids only) force consumers to call back for data; **fat events** (full state) decouple better but grow schemas. A common middle ground: the changed entity's state plus ids of related entities.
- Include an event id, type, version, timestamp, and a correlation/trace id in headers.

### Schema evolution
With Avro and a Schema Registry in `BACKWARD` compatibility mode, new consumers can read old data: you can add fields with defaults and delete fields, but not add required fields. Deploy consumers before producers for backward-compatible changes.

Read more: [Confluent: choosing the number of partitions](https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/) · [Confluent: schema evolution and compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)

## Spring Kafka

### A typical listener setup
```yaml
spring:
  kafka:
    bootstrap-servers: localhost:9092
    consumer:
      group-id: billing
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      properties:
        spring.deserializer.value.delegate.class: org.springframework.kafka.support.serializer.JsonDeserializer
        spring.json.trusted.packages: com.shop.events
    listener:
      ack-mode: record
      concurrency: 3
```

### Sending with a result check
```java
kafkaTemplate.send("orders", order.id().toString(), event)
    .whenComplete((result, ex) -> {
        if (ex != null) log.error("publish failed for {}", order.id(), ex);
    });
```
Fire-and-forget without checking means silent data loss on a broker outage. For must-not-lose events written together with DB changes, use the outbox.

### Testing
`@EmbeddedKafka` (in-memory broker) for fast tests, or Testcontainers with a real Kafka and `@ServiceConnection` for realistic ones.

Read more: [Spring for Apache Kafka reference](https://docs.spring.io/spring-kafka/reference/) · [Spring Boot: Kafka support](https://docs.spring.io/spring-boot/reference/messaging/kafka.html)

## Sources
- [Apache Kafka documentation](https://kafka.apache.org/documentation/): especially Design, Implementation and Operations.
- Gwen Shapira et al., *Kafka: The Definitive Guide*, 2nd edition.
- [Confluent Developer courses](https://developer.confluent.io/courses/): free, short video courses on Kafka internals.
- Martin Kleppmann, *Designing Data-Intensive Applications*, chapter 11 "Stream Processing".
