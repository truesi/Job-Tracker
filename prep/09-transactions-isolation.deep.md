# Transactions & isolation: deep dive

This page goes deeper on the short notes, section by section. Chapter 7 of Martin Kleppmann's *Designing Data-Intensive Applications* is the best single explanation of this topic.

## ACID

### What each letter costs
- **Atomicity** needs a way to undo: PostgreSQL simply never makes aborted row versions visible; InnoDB applies its undo log.
- **Durability** needs the WAL on stable storage before acknowledging the commit. PostgreSQL groups concurrent commits into one fsync (group commit). `synchronous_commit = off` returns before the flush: a crash can lose the last few hundred milliseconds of commits, but never corrupts data.
- **Consistency** in ACID means "the application's invariants hold". The database helps only through constraints (`NOT NULL`, `UNIQUE`, `FOREIGN KEY`, `CHECK`, exclusion constraints). Push as many invariants as possible into constraints: they're the only checks that hold under any concurrency.
- **Isolation** is where the trade-offs live, and it's what the rest of this page is about.

Read more: [PostgreSQL: WAL introduction](https://www.postgresql.org/docs/current/wal-intro.html) · [PostgreSQL: asynchronous commit](https://www.postgresql.org/docs/current/wal-async-commit.html)

## Read anomalies

### Lost update, step by step
| Time | Transaction A | Transaction B |
|---|---|---|
| 1 | `SELECT balance` → 100 | |
| 2 | | `SELECT balance` → 100 |
| 3 | `UPDATE ... SET balance = 110` | |
| 4 | `COMMIT` | |
| 5 | | `UPDATE ... SET balance = 110` (waits for A, then proceeds) |
| 6 | | `COMMIT`: A's +10 is lost |

### Write skew, step by step
```sql
-- both transactions, concurrently (REPEATABLE READ):
SELECT count(*) FROM doctors WHERE on_call AND shift_id = 1;   -- both see 2
UPDATE doctors SET on_call = false WHERE id = :me AND shift_id = 1;
COMMIT;                                                         -- both succeed, 0 on call
```
Neither transaction wrote a row the other wrote, so snapshot isolation sees no conflict. Typical real-world cases: double-booking a meeting room, two users claiming the same username via a check-then-insert (without a unique constraint), spending more than an account limit across two accounts.

Fixes, from simplest: a constraint (unique index, exclusion constraint); lock the rows you base the decision on (`SELECT ... FOR UPDATE`); materialize the conflict (lock a row representing the shift or room); use `SERIALIZABLE`.

Read more: [A Critique of ANSI SQL Isolation Levels (Berenson et al., 1995)](https://www.microsoft.com/en-us/research/publication/a-critique-of-ansi-sql-isolation-levels/) · [PostgreSQL wiki: SSI and write skew examples](https://wiki.postgresql.org/wiki/SSI)

## Isolation levels

### What PostgreSQL actually allows
| Level | Dirty read | Non-repeatable read | Phantom | Lost update | Write skew |
|---|---|---|---|---|---|
| Read committed | no | possible | possible | possible | possible |
| Repeatable read (snapshot) | no | no | no | no (error) | possible |
| Serializable (SSI) | no | no | no | no (error) | no (error) |

### How SSI works
Serializable Snapshot Isolation runs transactions on snapshots (no extra blocking), but tracks which data each transaction **read** (predicate "SIREAD" locks) and looks for a dangerous pattern of read-write dependencies between concurrent transactions. When it finds one, it aborts a transaction with `40001`. The trade-offs are more aborts under contention and some memory for tracking. Declaring read-only transactions as `READ ONLY` helps it.

### MySQL is different
InnoDB's REPEATABLE READ gives a snapshot for plain `SELECT`s, but `UPDATE`, `DELETE` and `SELECT ... FOR UPDATE` read the **latest committed** version and lock it, with gap locks to prevent phantoms. So in one transaction a `SELECT` can show a row an `UPDATE` then doesn't find, or the reverse. Gap locks are also a frequent source of deadlocks in MySQL under concurrent inserts.

### Retrying correctly
```java
@Retryable(retryFor = ConcurrencyFailureException.class, maxAttempts = 3, backoff = @Backoff(delay = 50))
@Transactional(isolation = Isolation.SERIALIZABLE)
public void transfer(long from, long to, BigDecimal amount) { ... }
```
The retry must wrap the **whole** transaction, outside of it (Spring Retry's advice is ordered to run before the transactional one). How Spring translates `40001` depends on the driver and version: it shows up as `CannotAcquireLockException` or as a plain `ConcurrencyFailureException`. The first is a subclass of the second, so retry on `ConcurrencyFailureException`.

Read more: [PostgreSQL: transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) · [MySQL: InnoDB isolation levels](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html)

## MVCC

### PostgreSQL's row versions
Every row version (tuple) carries `xmin` (the transaction that created it) and `xmax` (the transaction that deleted or replaced it). An `UPDATE` is a delete + insert: the old tuple gets an `xmax`, and a new tuple is written. A snapshot = "transactions committed before me"; a tuple is visible if its `xmin` committed in my snapshot and its `xmax` didn't.

```sql
SELECT xmin, xmax, * FROM accounts WHERE id = 1;   -- you can actually look
```

### Why VACUUM exists
Old tuples stay until no snapshot can see them anymore. `VACUUM` (usually autovacuum) marks their space reusable and updates the visibility map. It's blocked by the **oldest running snapshot** anywhere in the database: one forgotten transaction, a long report, or a stuck replication slot keeps every table growing. Watch `pg_stat_activity` for old `xact_start` and `state = 'idle in transaction'`.

### Transaction ID wraparound
Transaction IDs are 32-bit. VACUUM "freezes" old tuples so their IDs can be reused. If freezing can't keep up (VACUUM blocked for a very long time), PostgreSQL eventually refuses new writes to protect data. Rare, but a famous outage cause.

Read more: [PostgreSQL: MVCC introduction](https://www.postgresql.org/docs/current/mvcc-intro.html) · [PostgreSQL: routine vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)

## Locking

### Row lock modes in PostgreSQL
| Clause | Blocks | Typical use |
|---|---|---|
| `FOR UPDATE` | other FOR UPDATE/SHARE, UPDATE, DELETE | read-then-modify |
| `FOR NO KEY UPDATE` | the same, but not FOR KEY SHARE | what a normal UPDATE takes |
| `FOR SHARE` | updates and deletes | "this row must not change while I work" |
| `FOR KEY SHARE` | deleting the row or changing its key | taken by foreign key checks |

### A job queue on PostgreSQL
```sql
WITH next AS (
    SELECT id FROM jobs
    WHERE status = 'PENDING'
    ORDER BY created_at
    LIMIT 10
    FOR UPDATE SKIP LOCKED
)
UPDATE jobs SET status = 'RUNNING', started_at = now()
FROM next
WHERE jobs.id = next.id
RETURNING jobs.*;
```

### Migrations and the lock queue
`ALTER TABLE orders ADD COLUMN ...` needs an `ACCESS EXCLUSIVE` lock for a moment. If a long `SELECT` holds a weaker lock, the `ALTER` waits, and **every new query on the table queues behind the `ALTER`**: the table looks down. Always:
```sql
SET lock_timeout = '3s';     -- fail fast and retry the migration instead of freezing traffic
ALTER TABLE orders ADD COLUMN note text;
```

### Advisory locks
```sql
SELECT pg_try_advisory_xact_lock(hashtext('nightly-report'));   -- true for one instance only
```
They're handy for "only one instance runs this scheduled job" without extra infrastructure. ShedLock does the same with a table.

Read more: [PostgreSQL: explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) · [PostgreSQL: SELECT ... FOR UPDATE / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

## Optimistic vs pessimistic

### Choosing
| | Pessimistic | Optimistic |
|---|---|---|
| Conflict handling | wait | fail and retry |
| Best when | conflicts are frequent, work is short | conflicts are rare, or the user edits for minutes |
| Risks | deadlocks, waiting connections | retries storms under contention |
| Across HTTP requests | impossible (locks die with the transaction) | natural: send the version with the form |

### Optimistic locking across a web form
```java
@Entity
class Article {
    @Id Long id;
    @Version long version;
    String text;
}

// PUT /articles/42 with body {text, version: 7}
@Transactional
public void update(long id, ArticleDto dto) {
    Article a = repo.findById(id).orElseThrow();
    if (a.getVersion() != dto.version()) throw new ConflictException();   // someone saved first
    a.setText(dto.text());
}   // flush runs: UPDATE ... SET version = 8 WHERE id = 42 AND version = 7
```
HTTP has the same idea built in: `ETag` + `If-Match`, answered with `412 Precondition Failed`.

## Spring @Transactional

### How it works
`@EnableTransactionManagement` (on by default in Boot) wraps beans in proxies. The proxy asks the `PlatformTransactionManager` for a transaction, binds the connection to the current thread (`TransactionSynchronizationManager`), calls your method, then commits or rolls back. Everything that uses the same `DataSource` through Spring (JdbcTemplate, JPA repositories) picks up the thread-bound connection.

Consequences:
- **Self-invocation** skips the proxy. Calls must come from another bean.
- **Threads**: work in `@Async`, `CompletableFuture.supplyAsync` or a parallel stream runs **outside** the transaction.
- **Exceptions swallowed** inside the method mean commit.
- The transaction starts at the method boundary, so a `@Transactional` controller method holds a DB connection for the whole request.

### Propagation, visually
```
REQUIRED:      outer ──[ tx1 ──── inner joins tx1 ──── ]── one commit
REQUIRES_NEW:  outer ──[ tx1 ── (suspended) ── ]
                         inner ──[ tx2 ]── commits on its own connection
NESTED:        outer ──[ tx1 ── savepoint ── inner ── rollback to savepoint? ── ]
```

### Events after commit
```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlaced event) {
    emailClient.sendConfirmation(event.orderId());   // only if the order really committed
}
```
That's the simplest way to keep emails and HTTP calls out of the transaction without sending them for orders that rolled back. For guaranteed delivery, use the outbox.

Read more: [Spring: using @Transactional](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html) · [Spring: transaction propagation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html) · [Spring: transaction-bound events](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)

## Distributed transactions

### Saga example: placing an order
```
Order service:    create order (PENDING) ──────────────────────────────┐
Payment service:  charge card ── ok ──> Inventory: reserve ── fails ──>│
                  refund card  <── compensation ─────────────────────── │
Order service:    mark order CANCELLED <────────────────────────────────┘
```
- **Orchestration**: an order saga orchestrator sends commands and tracks state. Easier to follow and to debug.
- **Choreography**: services react to each other's events. Looser coupling, but the flow is implicit and harder to trace.
- Sagas give up isolation: other transactions see intermediate states (an order that is PENDING and later cancelled). Design the states to make that harmless ("semantic locks").

### Outbox in practice
```sql
BEGIN;
INSERT INTO orders (...) VALUES (...);
INSERT INTO outbox (id, aggregate_id, type, payload) VALUES (gen_random_uuid(), :orderId, 'OrderPlaced', :json);
COMMIT;
```
A relay publishes outbox rows to Kafka: either polling (`SELECT ... FOR UPDATE SKIP LOCKED`, publish, mark sent) or CDC (Debezium reads the WAL, so no polling load and no ordering problems). Either way delivery is **at least once**, so consumers deduplicate by event id.

Read more: [microservices.io: Saga](https://microservices.io/patterns/data/saga.html) · [microservices.io: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) · [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

## Sources
- Martin Kleppmann, *Designing Data-Intensive Applications*, chapter 7 "Transactions" and chapter 9 "Consistency and Consensus".
- [PostgreSQL: Concurrency Control chapter](https://www.postgresql.org/docs/current/mvcc.html)
- [Jepsen: consistency models](https://jepsen.io/consistency): a map of every isolation and consistency guarantee and how they relate.
- Vlad Mihalcea, *High-Performance Java Persistence*: transactions and locking from the JDBC/JPA side.
