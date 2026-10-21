# Transactions & isolation

## ACID
- **Atomicity**: all or nothing; a failure rolls everything back.
- **Consistency**: constraints and invariants hold before and after. Largely the application's job, with help from DB constraints.
- **Isolation**: concurrent transactions don't see each other's intermediate state, to the degree of the isolation level.
- **Durability**: a committed transaction survives a crash. The write-ahead log (WAL) is flushed (fsync) before `COMMIT` returns.

## Read anomalies
- **Dirty read**: reading data another transaction hasn't committed (and may roll back).
- **Non-repeatable read**: reading the same row twice gives different values, because another transaction committed in between.
- **Phantom read**: re-running a range query returns new rows that another transaction inserted.
- **Lost update**: two read-modify-write cycles on the same row; the second write overwrites the first.
- **Write skew**: two transactions read overlapping data and update *different* rows, together breaking an invariant (two doctors both go off call, leaving none).

## Isolation levels
- SQL standard levels: `READ UNCOMMITTED` < `READ COMMITTED` < `REPEATABLE READ` < `SERIALIZABLE`, defined by which anomalies they forbid.
- **PostgreSQL**: default `READ COMMITTED`. `READ UNCOMMITTED` behaves like `READ COMMITTED`. `REPEATABLE READ` is snapshot isolation (no phantoms either; a concurrent update of the same row raises a serialization error). `SERIALIZABLE` is SSI: it also detects write skew and aborts one transaction with SQLSTATE `40001`.
- **MySQL InnoDB**: default `REPEATABLE READ`, with snapshot reads plus next-key (gap) locks for locking reads.
- **Oracle**: default `READ COMMITTED`; its `SERIALIZABLE` is snapshot isolation.
- Higher isolation = more aborts or blocking. Code must **retry** serialization failures.

## MVCC
- Multi-version concurrency control: a writer creates a new row version, readers keep seeing the version from their snapshot. **Readers don't block writers, and writers don't block readers.**
- `READ COMMITTED`: a new snapshot per statement. `REPEATABLE READ`/`SERIALIZABLE`: one snapshot per transaction.
- PostgreSQL keeps old versions in the table (`xmin`/`xmax` per row); `VACUUM` removes dead ones. InnoDB and Oracle keep old versions in an undo log.
- Long-running or idle-in-transaction sessions prevent cleanup: bloat, slow queries, and in the extreme transaction ID wraparound.

## Locking
- Row locks: `SELECT ... FOR UPDATE` (exclusive), `FOR SHARE`, `NOWAIT` (fail instead of waiting), `SKIP LOCKED` (take free rows only: job queues).
- Writers lock the rows they change until commit, so two updates of the same row are serialized.
- DDL takes strong table locks (`ACCESS EXCLUSIVE` in PostgreSQL); a waiting `ALTER TABLE` blocks every query behind it. Set `lock_timeout` in migrations.
- **Deadlock**: the database detects the cycle and aborts one transaction. Prevent it with a consistent lock order; handle it with a retry.
- Advisory locks (`pg_advisory_xact_lock(key)`) lock application-defined keys.

## Optimistic vs pessimistic
- **Pessimistic**: lock first (`FOR UPDATE`), then modify. Good for high contention and short transactions.
- **Optimistic**: a `version` column; `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`; 0 rows updated means a conflict, so retry or tell the user. JPA `@Version`. Good for low contention and long user "think time".
- Often you need neither: an atomic statement such as `UPDATE accounts SET balance = balance - 100 WHERE id = ? AND balance >= 100`, then check the row count.

## Spring @Transactional
- It works through a **proxy**: calls from inside the same class (self-invocation) bypass it, and so does a method the proxy can't intercept (private, final).
- Rolls back on `RuntimeException` and `Error`; **checked exceptions commit** unless you set `rollbackFor`.
- Propagation: `REQUIRED` (default: join or create), `REQUIRES_NEW` (suspend the outer transaction, run a separate one on another connection), `NESTED` (savepoint), `SUPPORTS`, `MANDATORY`, `NOT_SUPPORTED`, `NEVER`.
- `readOnly = true`: Hibernate skips dirty checking and flushes; the connection is marked read-only (routing to a replica becomes possible).
- "Transaction silently rolled back because it has been marked as rollback-only": an inner `REQUIRED` method threw, and the outer one caught the exception and tried to commit.
- Keep transactions short: no HTTP calls or user waits inside them, since they hold a connection and locks.

## Distributed transactions
- **2PC / XA**: a coordinator runs prepare, then commit, across resources. It's blocking (participants hold locks while waiting for the coordinator) and rare in microservices.
- **Saga**: a sequence of local transactions with compensating actions on failure, driven by orchestration (a central coordinator) or choreography (events).
- **Transactional outbox**: write the business change and the event in the same DB transaction; a relay (polling or CDC with Debezium) publishes it. Consumers must be **idempotent** (at-least-once delivery).
