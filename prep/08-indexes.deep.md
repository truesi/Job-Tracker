# Indexes: deep dive

This page goes deeper on the short notes, section by section. Examples are PostgreSQL unless noted. Markus Winand's *Use The Index, Luke* is the best single resource on this topic and is free online.

## What an index is

### The cost model in one picture
A query without an index reads every page of the table (sequential I/O, cheap per page). With an index it reads a few index pages, then **one table page per matching row** (random I/O, expensive per page, unless the rows happen to be physically together). Whether the index wins depends on how many rows match:

- 1 row out of 10 million: index, by orders of magnitude.
- 30% of rows: almost always a sequential scan.
- In between, the planner decides from statistics and the physical correlation of the column with the table order (`pg_stats.correlation`).

### Heap tables vs clustered tables
- **PostgreSQL**: a table is an unordered heap; every index (including the primary key) points to a physical location (TID). An update creates a new row version at a new location, so every index has to learn about it, unless it's a HOT update.
- **InnoDB (MySQL)**: the table is stored inside the primary key B-tree. Rows are physically ordered by PK, PK range scans are very fast, and secondary indexes point to the PK value, not a location.

Read more: [PostgreSQL: Indexes chapter](https://www.postgresql.org/docs/current/indexes.html) · [Use The Index, Luke: anatomy of an index](https://use-the-index-luke.com/sql/anatomy)

## B-tree

### Lookup and range scan
1. Start at the root page and binary-search its keys to choose a child.
2. Repeat down to the leaf level (3–4 hops).
3. For a range, walk the linked leaf pages sideways until past the end of the range.
4. For each entry, fetch the row from the table (unless the scan is index-only).

The **leaf walk** and the **table fetches** are what make an index scan slow; the tree descent itself is cheap.

### Sorting and LIKE
- A B-tree can be read in both directions, so one index on `(created_at)` serves both `ORDER BY created_at ASC` and `DESC`. Mixed orders over several columns (`a ASC, b DESC`) need an index declared that way.
- `LIKE 'abc%'` becomes a range `>= 'abc' AND < 'abd'`, but only if the collation sorts characters byte-wise. With a non-C collation, create the index with `text_pattern_ops`.

### NULLs
B-trees in PostgreSQL store NULLs, so `IS NULL` can use the index. Oracle doesn't index all-NULL keys, a classic cross-database difference.

Read more: [PostgreSQL: B-tree indexes](https://www.postgresql.org/docs/current/btree.html) · [PostgreSQL: indexes and ORDER BY](https://www.postgresql.org/docs/current/indexes-ordering.html)

## Composite indexes

### Why the leftmost-prefix rule exists
A composite index is sorted like a phone book: by last name, then first name. Finding "all Smiths" or "Smith, John" is one seek. Finding "all Johns" means reading the whole book.

### Equality first, range last
```sql
-- query
WHERE tenant_id = 7 AND status = 'OPEN' AND created_at >= now() - interval '7 days'

-- good: seek to (7, 'OPEN', <date>), then read one contiguous slice
CREATE INDEX ON tickets (tenant_id, status, created_at);

-- worse: the seek uses tenant_id and the created_at range; status is only filtered inside it
CREATE INDEX ON tickets (tenant_id, created_at, status);
```

### Index for the ORDER BY + LIMIT pattern
```sql
-- "latest 20 orders of a customer": the most common query shape in web apps
SELECT * FROM orders
WHERE customer_id = :id
ORDER BY created_at DESC
LIMIT 20;

CREATE INDEX ON orders (customer_id, created_at DESC);
```
The plan becomes an index scan that stops after 20 entries, regardless of how many orders the customer has. These "pipelined" top-N queries are where indexes give 1000× speedups.

### Skip scan
PostgreSQL 18 (and MySQL 8.0.13+) can use `(a, b)` for `WHERE b = ?` when `a` has few distinct values, by doing one seek per value of `a`. It's a planner optimization, not a reason to design indexes in the wrong order.

Read more: [PostgreSQL: multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html) · [Use The Index, Luke: concatenated keys](https://use-the-index-luke.com/sql/where-clause/the-equals-operator/concatenated-keys)

## Covering indexes and index-only scans

### INCLUDE columns
```sql
CREATE INDEX orders_customer_idx ON orders (customer_id) INCLUDE (status, amount);

-- answered from the index alone
SELECT status, amount FROM orders WHERE customer_id = 42;
```
`INCLUDE` columns are stored only in the leaves and aren't part of the sort order, so they don't affect uniqueness and keep inner pages small.

### The visibility map catch
PostgreSQL indexes don't store transaction visibility. An index-only scan checks the **visibility map**: if the page is marked all-visible, the table is skipped; otherwise the row is fetched to check it. `EXPLAIN ANALYZE` shows this as `Heap Fetches: N`. On a frequently updated table, index-only scans degrade until `VACUUM` runs.

### InnoDB specifics
- Every secondary index implicitly includes the primary key, so `SELECT id FROM t WHERE email = ?` is covered by an index on `email`.
- The primary key choice shapes the whole table: an auto-increment `BIGINT` appends to the end; a random UUID inserts everywhere, causing page splits and pages that stay only partly full. If you need UUIDs, use time-ordered ones (UUIDv7) or store them as `BINARY(16)`.

Read more: [PostgreSQL: index-only scans and covering indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html) · [MySQL: clustered and secondary indexes](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)

## Other index types (PostgreSQL)

```sql
-- equality only
CREATE INDEX ON sessions USING hash (token);

-- jsonb containment, arrays, full-text
CREATE INDEX ON products USING gin (attributes jsonb_path_ops);
SELECT * FROM products WHERE attributes @> '{"color": "red"}';

-- substring search
CREATE EXTENSION pg_trgm;
CREATE INDEX ON users USING gin (name gin_trgm_ops);
SELECT * FROM users WHERE name ILIKE '%ova%';

-- no overlapping bookings for the same room
CREATE EXTENSION btree_gist;
ALTER TABLE bookings ADD CONSTRAINT no_overlap
    EXCLUDE USING gist (room_id WITH =, during WITH &&);

-- huge append-only table
CREATE INDEX ON events USING brin (created_at);

-- partial and expression indexes
CREATE INDEX ON orders (created_at) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX ON users (lower(email));
```
A partial **unique** index is a neat trick for rules like "one active subscription per user": `CREATE UNIQUE INDEX ON subscriptions (user_id) WHERE active`.

GIN indexes are slow to update (each document produces many entries), so PostgreSQL buffers changes in a "pending list". Large bulk loads are faster with the index dropped and recreated.

Read more: [PostgreSQL: index types](https://www.postgresql.org/docs/current/indexes-types.html) · [PostgreSQL: partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html) · [PostgreSQL: expression indexes](https://www.postgresql.org/docs/current/indexes-expressional.html) · [PostgreSQL: pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) · [PostgreSQL: BRIN](https://www.postgresql.org/docs/current/brin.html)

## When indexes aren't used

### Sargable rewrites
| Not sargable | Sargable |
|---|---|
| `WHERE DATE(created_at) = '2024-03-01'` | `WHERE created_at >= '2024-03-01' AND created_at < '2024-03-02'` |
| `WHERE amount * 1.2 > 100` | `WHERE amount > 100 / 1.2` |
| `WHERE substring(code, 1, 3) = 'ABC'` | `WHERE code LIKE 'ABC%'` |
| `WHERE coalesce(deleted, false) = false` | `WHERE deleted IS NOT TRUE` + a partial index, or make the column `NOT NULL` |

### Statistics
`ANALYZE` samples each column: number of distinct values, most common values with their frequencies, a histogram, NULL fraction and physical correlation. The planner assumes columns are **independent**: `city = 'Almaty' AND country = 'KZ'` is estimated as the product of both selectivities, far too low. `CREATE STATISTICS ... (dependencies) ON city, country FROM addresses` fixes that.

### Generic plans
A server-side prepared statement in PostgreSQL (pgjdbc switches to one after 5 executions by default) gets custom plans for its first 5 runs, then a **generic plan** if that isn't estimated to be worse. For skewed data (one tenant with 90% of the rows), a generic plan can be terrible for some parameter values. If a query is fast in psql but slow from the app, this is a prime suspect (`plan_cache_mode`).

Read more: [PostgreSQL: statistics used by the planner](https://www.postgresql.org/docs/current/planner-stats.html) · [PostgreSQL: CREATE STATISTICS](https://www.postgresql.org/docs/current/sql-createstatistics.html)

## Reading EXPLAIN

```
Limit  (cost=0.43..8.95 rows=20 width=64) (actual time=0.031..0.058 rows=20 loops=1)
  ->  Index Scan using orders_customer_id_created_at_idx on orders
        (cost=0.43..4123.11 rows=9671 width=64) (actual time=0.030..0.054 rows=20 loops=1)
        Index Cond: (customer_id = 42)
        Buffers: shared hit=24
Planning Time: 0.110 ms
Execution Time: 0.079 ms
```
- `cost=startup..total` is in arbitrary planner units. `actual time` is in ms, **per loop**: multiply by `loops`.
- `rows` estimated vs actual: a 10× gap or more deserves attention.
- `Buffers: shared hit` = pages from cache, `read` = from disk/OS.
- Red flags: `Seq Scan` on a big table with `Rows Removed by Filter` in the millions; `Sort Method: external merge Disk`; a `Nested Loop` with a large `loops` count on the inner side.

Paste plans into a visualizer (explain.dalibo.com, explain.depesz.com) for long queries.

Read more: [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [explain.dalibo.com](https://explain.dalibo.com/)

## Index maintenance

### Bloat and rebuilding
Deleted and updated rows leave dead index entries until VACUUM removes them, and page splits leave half-empty pages. Heavily updated indexes grow beyond their ideal size. `REINDEX INDEX CONCURRENTLY` (PostgreSQL 12+) rebuilds without blocking writes.

### A safe migration recipe for a big table
```sql
-- in a migration that is NOT wrapped in a transaction (Flyway/Liquibase setting)
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_customer_created_idx
    ON orders (customer_id, created_at DESC);

-- check it finished validly
SELECT indexrelid::regclass, indisvalid FROM pg_index
WHERE indexrelid = 'orders_customer_created_idx'::regclass;
```
If the build fails, the index stays `INVALID` (it still slows writes): drop it and retry.

### Auditing
```sql
-- indexes never scanned since stats reset
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```
Also look for duplicates: `(a)` is redundant next to `(a, b)`, unless it's needed for a constraint or is much smaller and hot.

Read more: [PostgreSQL: CREATE INDEX (building indexes concurrently)](https://www.postgresql.org/docs/current/sql-createindex.html) · [PostgreSQL: REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html) · [PostgreSQL: Heap-Only Tuples](https://www.postgresql.org/docs/current/storage-hot.html)

## Sources
- [Use The Index, Luke](https://use-the-index-luke.com/) by Markus Winand, also published as the book *SQL Performance Explained*.
- [PostgreSQL documentation: Indexes](https://www.postgresql.org/docs/current/indexes.html) and [Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html).
- Alex Petrov, *Database Internals*: how B-trees and LSM trees work on disk.
