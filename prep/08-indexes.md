# Indexes

## What an index is
- A separate sorted structure mapping key → row location (a TID in PostgreSQL, the primary key in InnoDB secondary indexes).
- It speeds up reads and costs writes: every `INSERT`, `DELETE` and many `UPDATE`s must maintain **every** index, and each index takes disk space and cache memory.
- Constraints rely on them: `PRIMARY KEY` and `UNIQUE` are enforced by unique indexes. PostgreSQL does **not** create indexes on foreign key columns automatically.

## B-tree
- The default type: balanced, high fan-out (hundreds of keys per page), usually 3–4 levels even for hundreds of millions of rows.
- Leaves are linked and sorted, so a B-tree serves `=`, `<`, `>`, `BETWEEN`, `IN`, `ORDER BY`, `MIN`/`MAX` and prefix `LIKE 'abc%'` (in PostgreSQL with C collation or `text_pattern_ops`).
- Lookup is O(log n): a few page reads, which are usually cached.

## Composite indexes
- **Leftmost prefix rule**: an index on `(a, b, c)` helps queries on `a`, `a, b` and `a, b, c`, but not on `b` alone (PostgreSQL 18 and MySQL 8.0.13+ can skip-scan in limited cases).
- Column order: **equality columns first, range column last**. After a range condition, later columns can't narrow the seek any more.
- The index can also deliver rows already sorted: `(customer_id, created_at)` serves `WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10` without a sort.
- One composite index usually beats several single-column indexes for a frequent multi-column filter.

## Covering indexes and index-only scans
- If the index contains every column a query needs, the database can answer from the index alone (**index-only scan**). PostgreSQL 11+: `CREATE INDEX ... (customer_id) INCLUDE (status, amount)`.
- PostgreSQL must still check row visibility; an index-only scan skips the table only for pages marked all-visible in the visibility map (kept up to date by `VACUUM`).
- **InnoDB**: the table *is* a B-tree on the primary key (clustered index). Secondary indexes store the primary key, so a secondary lookup traverses two trees, and a wide primary key bloats every secondary index.
- Random UUIDv4 primary keys scatter inserts across the clustered index (page splits, poor cache use). Prefer sequential keys: `BIGINT` identity or time-ordered UUIDv7.

## Other index types (PostgreSQL)
- **Hash**: equality only.
- **GIN**: "contains" queries on arrays, `jsonb` (`@>`), full-text search, trigram search (`pg_trgm`) for `LIKE '%abc%'`.
- **GiST**: geometry, ranges, exclusion constraints (no overlapping bookings), nearest-neighbor search.
- **BRIN**: block ranges for huge, naturally ordered tables (append-only logs by time). Tiny and cheap, but coarse.
- **Partial**: `CREATE INDEX ... WHERE status = 'ACTIVE'`, which indexes only the hot subset.
- **Expression**: `CREATE INDEX ... ON users (lower(email))`, which matches `WHERE lower(email) = ?`.

## When indexes aren't used
- A function or arithmetic on the column (`WHERE DATE(created_at) = ...`, `WHERE price * 2 > 100`).
- An implicit type conversion (comparing a `varchar` column with a number in MySQL).
- A leading wildcard: `LIKE '%son'`.
- **Low selectivity**: if a large share of rows matches, a sequential scan is cheaper than many random page reads.
- Stale statistics (run `ANALYZE`), small tables, `OR` across different columns (may become a BitmapOr or a seq scan), `<>`/`NOT IN`.
- The PostgreSQL planner is cost-based: it estimates rows from statistics (distinct values, most common values, histograms) and picks the cheapest plan.

## Reading EXPLAIN
- Scan nodes: `Seq Scan`, `Index Scan`, `Index Only Scan`, `Bitmap Index Scan` + `Bitmap Heap Scan` (many rows from an index, read in page order).
- Join nodes: `Nested Loop`, `Hash Join`, `Merge Join`.
- `EXPLAIN (ANALYZE, BUFFERS)`: compare estimated with actual rows, find the slowest node, look at `Rows Removed by Filter` and at disk reads vs cache hits.

## Index maintenance
- Find unused indexes: `pg_stat_user_indexes.idx_scan = 0` (over a long enough period, on all replicas).
- Create without blocking writes: `CREATE INDEX CONCURRENTLY` (slower, can't run in a transaction, leaves an INVALID index on failure). Rebuild bloated ones with `REINDEX CONCURRENTLY`.
- PostgreSQL **HOT updates**: if no indexed column changes and the page has free space, an update touches no index at all. Another reason not to index everything.
