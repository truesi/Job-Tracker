# SQL

## Query execution order
- Logical order: `FROM`/`JOIN` → `WHERE` → `GROUP BY` → `HAVING` → `SELECT` (window functions run here) → `DISTINCT` → `ORDER BY` → `LIMIT`/`OFFSET`.
- That's why a `SELECT` alias can't be used in `WHERE`, but can be used in `ORDER BY`. It's also why a window function can't go in `WHERE`: wrap the query in a subquery or CTE.
- The physical plan can differ completely; the logical order only defines what the result means.

## Joins
- `INNER`: only matching rows. `LEFT`: all left rows, NULLs where there's no match. `RIGHT`, `FULL OUTER`, `CROSS` (Cartesian product), self join.
- A condition on the right table in `WHERE` turns a `LEFT JOIN` into an inner join. Put it in `ON`.
- **Semi-join**: `EXISTS`/`IN`. **Anti-join**: `NOT EXISTS`. `NOT IN` returns no rows at all if the subquery contains a NULL.
- One-to-many joins multiply rows (**fan-out**). Aggregating after joining two child tables double-counts.

## NULL
- Three-valued logic: `NULL = NULL` is UNKNOWN, not TRUE. Use `IS NULL` and `IS [NOT] DISTINCT FROM`.
- `WHERE` keeps only TRUE rows, so `col <> 'x'` silently drops NULLs.
- `COUNT(*)` counts rows; `COUNT(col)` skips NULLs. `SUM`/`AVG`/`MIN`/`MAX` ignore NULLs. `SUM` over zero rows is NULL, not 0.
- `COALESCE(a, b, 0)` returns the first non-null value. `NULLIF(a, 0)` avoids division by zero.

## Grouping and aggregates
- Every non-aggregated column in `SELECT` must be in `GROUP BY` (or functionally dependent on the grouped primary key in PostgreSQL).
- `WHERE` filters rows before grouping; `HAVING` filters groups after.
- PostgreSQL extras: `COUNT(*) FILTER (WHERE status = 'PAID')`, `string_agg`, `array_agg`, `GROUPING SETS`, `ROLLUP`, `CUBE`.

## Window functions
- `fn() OVER (PARTITION BY ... ORDER BY ... frame)` computes over related rows **without collapsing them**.
- `ROW_NUMBER` (1, 2, 3), `RANK` (1, 1, 3: gaps), `DENSE_RANK` (1, 1, 2), `NTILE(n)`.
- `LAG`/`LEAD`: the previous or next row's value. `FIRST_VALUE`/`LAST_VALUE`.
- Running total: `SUM(amount) OVER (ORDER BY day)`. Moving average: frame `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW`.
- Top-N per group: `ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC)` in a CTE, then `WHERE rn <= N`.

## Subqueries and CTEs
- Scalar, row, table subqueries; correlated subqueries reference the outer row.
- `WITH` (CTE) names a subquery. `WITH RECURSIVE` walks hierarchies (org charts, category trees, graphs).
- PostgreSQL 12+ inlines non-recursive CTEs unless you write `MATERIALIZED`.
- `UNION` removes duplicates (extra sort or hash); `UNION ALL` doesn't, and is faster. `INTERSECT`, `EXCEPT`.

## Classic tasks
- Second highest salary, N-th highest, top-N per group.
- Find duplicates (`GROUP BY ... HAVING COUNT(*) > 1`) and delete them, keeping one row.
- Employees earning more than their manager (self join).
- Customers without orders (anti-join).
- Running totals, month-over-month change (`LAG`), gaps and islands (consecutive streaks).

## Writing good SQL
- Pagination: `OFFSET` reads and throws away all skipped rows. **Keyset pagination** (`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20`) stays fast.
- Keep predicates **sargable**: `WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02'`, not `WHERE DATE(created_at) = ...`.
- Avoid `SELECT *` in application code: it defeats index-only scans and breaks when columns change.
- Upsert: `INSERT ... ON CONFLICT (key) DO UPDATE` (PostgreSQL), `MERGE` (SQL standard, PostgreSQL 15+).
- `DELETE` removes rows one by one (with `WHERE`, triggers, returns counts); `TRUNCATE` empties a table at once (transactional in PostgreSQL); `DROP` removes the table.
- `EXPLAIN (ANALYZE, BUFFERS)` shows the real plan, row counts and I/O.
