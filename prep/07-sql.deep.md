# SQL: deep dive

This page goes deeper on the short notes, section by section. Examples are in PostgreSQL. The tables used throughout: `emp(id, name, dept_id, manager_id, salary)`, `dept(id, name)`, `orders(id, customer_id, created_at, amount, status)`.

## Query execution order

### Walking through one query
```sql
SELECT d.name, COUNT(*) AS cnt                -- 5. pick columns, compute aggregates
FROM emp e JOIN dept d ON d.id = e.dept_id    -- 1. build the joined rows
WHERE e.salary > 1000                         -- 2. filter rows
GROUP BY d.name                               -- 3. group
HAVING COUNT(*) > 5                           -- 4. filter groups
ORDER BY cnt DESC                             -- 6. sort (alias visible now)
LIMIT 10;                                     -- 7. cut
```
Knowing this order answers a whole class of questions: why aliases fail in `WHERE`, why `HAVING` can use aggregates, why window functions see rows after `WHERE` and `GROUP BY` (so `COUNT(*) OVER ()` after a filter counts filtered rows), and why `DISTINCT` + `ORDER BY` needs the sort columns in the select list.

Read more: [PostgreSQL: SELECT](https://www.postgresql.org/docs/current/sql-select.html) · [PostgreSQL: Queries chapter](https://www.postgresql.org/docs/current/queries.html)

## Joins

### ON vs WHERE in outer joins
```sql
-- all customers, with their paid orders if any
SELECT c.name, o.id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'PAID';
```
The `ON` condition decides which rows *match*; unmatched left rows survive with NULLs. A `WHERE` condition filters the *result*, after the NULLs are added.

### Semi- and anti-joins
```sql
-- customers with at least one order (no duplicates, unlike a JOIN)
SELECT * FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);

-- customers without orders
SELECT * FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```
PostgreSQL plans `EXISTS` as a semi/anti-join (hash or merge), so it's not slower than a join. Prefer it over `IN (subquery)` when duplicates or NULLs can matter.

### Join algorithms (what you see in EXPLAIN)
- **Nested loop**: for each outer row, look up inner rows. Great when the outer side is small and the inner side has an index.
- **Hash join**: build a hash table on the smaller input, probe with the larger one. Good for big unsorted inputs with equality conditions.
- **Merge join**: both inputs sorted on the join key, walked together. Good when the inputs are already sorted (for example by indexes).

### Fan-out, fixed
```sql
SELECT c.id, o.order_total, p.paid_total
FROM customers c
LEFT JOIN (SELECT customer_id, SUM(amount) AS order_total FROM orders GROUP BY customer_id) o
       ON o.customer_id = c.id
LEFT JOIN (SELECT customer_id, SUM(amount) AS paid_total FROM payments GROUP BY customer_id) p
       ON p.customer_id = c.id;
```

Read more: [PostgreSQL: table expressions and joins](https://www.postgresql.org/docs/current/queries-table-expressions.html) · [PostgreSQL: subquery expressions](https://www.postgresql.org/docs/current/functions-subquery.html)

## NULL

### Truth tables in one line
`TRUE AND UNKNOWN = UNKNOWN`, `FALSE AND UNKNOWN = FALSE`, `TRUE OR UNKNOWN = TRUE`, `NOT UNKNOWN = UNKNOWN`. `WHERE`, `HAVING` and `JOIN ON` keep a row only if the condition is **TRUE**; `CHECK` constraints reject a row only if the condition is **FALSE**, so NULL passes a CHECK.

### Practical consequences
```sql
WHERE status <> 'CANCELLED'                      -- drops rows where status IS NULL
WHERE status IS DISTINCT FROM 'CANCELLED'        -- keeps them
WHERE a IS NOT DISTINCT FROM b                   -- NULL-safe equality
SELECT COALESCE(SUM(amount), 0) FROM orders WHERE false;   -- 0, not NULL
SELECT total / NULLIF(count, 0)                  -- NULL instead of division by zero
```
- `UNIQUE` allows many NULLs by default (each NULL is distinct). PostgreSQL 15 added `UNIQUE NULLS NOT DISTINCT`.
- `ORDER BY` puts NULLs **last** in ascending order in PostgreSQL (and first in MySQL); use `NULLS FIRST/LAST` explicitly.
- `GROUP BY` and `DISTINCT` treat all NULLs as one group.

Read more: [PostgreSQL: comparison functions and IS DISTINCT FROM](https://www.postgresql.org/docs/current/functions-comparison.html) · [Modern SQL: NULL in SQL](https://modern-sql.com/concept/null)

## Grouping and aggregates

### Conditional aggregation
```sql
SELECT date_trunc('month', created_at) AS month,
       COUNT(*)                                   AS orders,
       COUNT(*) FILTER (WHERE status = 'PAID')    AS paid,
       SUM(amount) FILTER (WHERE status = 'PAID') AS revenue
FROM orders
GROUP BY 1
ORDER BY 1;
```
In databases without `FILTER`, use `SUM(CASE WHEN status = 'PAID' THEN amount END)`. This turns rows into columns (a pivot) in a single pass.

### Subtotals
```sql
SELECT dept_id, status, SUM(amount)
FROM orders
GROUP BY ROLLUP (dept_id, status);    -- per (dept, status), per dept, and a grand total
```

Read more: [PostgreSQL: aggregate functions](https://www.postgresql.org/docs/current/functions-aggregate.html) · [PostgreSQL: GROUPING SETS, CUBE, ROLLUP](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-GROUPING-SETS)

## Window functions

### Anatomy
```sql
SELECT name, dept_id, salary,
       AVG(salary)  OVER (PARTITION BY dept_id)                        AS dept_avg,
       salary - AVG(salary) OVER (PARTITION BY dept_id)                AS diff_from_avg,
       RANK()       OVER (PARTITION BY dept_id ORDER BY salary DESC)   AS rank_in_dept,
       SUM(salary)  OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
FROM emp;
```

### The frame trap
With `ORDER BY` and no frame, the default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Two consequences:
- Rows with **equal** `ORDER BY` values are peers and get the same running total. Use `ROWS` for a strictly row-by-row total.
- `LAST_VALUE(x) OVER (ORDER BY ...)` returns the current row, not the partition's last one. Write `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.

### Named windows
```sql
SELECT day, revenue,
       AVG(revenue) OVER w7 AS avg_7d,
       MAX(revenue) OVER w7 AS max_7d
FROM daily_revenue
WINDOW w7 AS (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW);
```

Read more: [PostgreSQL tutorial: window functions](https://www.postgresql.org/docs/current/tutorial-window.html) · [PostgreSQL: window function list](https://www.postgresql.org/docs/current/functions-window.html)

## Subqueries and CTEs

### Recursive CTE: everyone under a manager
```sql
WITH RECURSIVE subordinates AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM emp
    WHERE id = 42                                  -- anchor: the starting manager
  UNION ALL
    SELECT e.id, e.name, e.manager_id, s.depth + 1
    FROM emp e
    JOIN subordinates s ON e.manager_id = s.id     -- recursive step
)
SELECT * FROM subordinates;
```
Guard against cycles in dirty data with a depth limit, or the `CYCLE` clause (PostgreSQL 14+).

### CTE materialization
Before PostgreSQL 12, every CTE was an "optimization fence": computed once in full, with outer filters not pushed into it. Since 12, a non-recursive CTE referenced once is inlined like a subquery. `WITH x AS MATERIALIZED (...)` forces the old behavior, which helps when an expensive CTE is referenced several times.

### LATERAL
`JOIN LATERAL` lets a subquery reference columns of earlier tables in the `FROM` clause, like a for-each loop. It's a neat way to do top-N per group with an index:
```sql
SELECT c.id, o.*
FROM customers c
CROSS JOIN LATERAL (
    SELECT id, amount FROM orders
    WHERE customer_id = c.id
    ORDER BY created_at DESC
    LIMIT 3
) o;
```

Read more: [PostgreSQL: WITH queries](https://www.postgresql.org/docs/current/queries-with.html) · [PostgreSQL: LATERAL subqueries](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-LATERAL)

## Classic tasks

### N-th highest salary per department
```sql
SELECT dept_id, salary
FROM (
    SELECT dept_id, salary,
           DENSE_RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS r
    FROM emp
) t
WHERE r = 2;
```

### Delete duplicates, keep the lowest id
```sql
DELETE FROM users u
USING (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY id) AS rn
    FROM users
) d
WHERE u.id = d.id AND d.rn > 1;
```

### Employees earning more than their manager
```sql
SELECT e.name
FROM emp e
JOIN emp m ON m.id = e.manager_id
WHERE e.salary > m.salary;
```

### Month-over-month growth
```sql
SELECT month, revenue,
       ROUND(100.0 * (revenue - LAG(revenue) OVER (ORDER BY month))
             / NULLIF(LAG(revenue) OVER (ORDER BY month), 0), 1) AS growth_pct
FROM monthly_revenue;
```

### Gaps and islands: login streaks
Consecutive dates minus their row number give the same value within a streak:
```sql
SELECT user_id, MIN(day) AS streak_start, MAX(day) AS streak_end, COUNT(*) AS days
FROM (
    SELECT user_id, day,
           day - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY day))::int AS grp
    FROM (SELECT DISTINCT user_id, login_at::date AS day FROM logins) d
) t
GROUP BY user_id, grp
ORDER BY days DESC;
```

## Writing good SQL

### Keyset pagination
```sql
-- first page
SELECT id, created_at, title FROM posts
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- next page: pass the last row's (created_at, id)
SELECT id, created_at, title FROM posts
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```
With an index on `(created_at DESC, id DESC)` every page costs the same. The `id` tie-breaker keeps the order total and stable. The trade-off: no "jump to page 57".

### Upsert patterns
```sql
INSERT INTO daily_stats (day, views)
VALUES (CURRENT_DATE, 1)
ON CONFLICT (day) DO UPDATE SET views = daily_stats.views + EXCLUDED.views;

INSERT INTO tags (name) VALUES ('java')
ON CONFLICT (name) DO NOTHING;
```

### EXPLAIN basics
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```
Look at the node with the largest actual time, compare **estimated vs actual rows** (a big gap means bad statistics or correlated columns), and check `Buffers: shared read` (disk) vs `hit` (cache). `ANALYZE` executes the query, so wrap writes in `BEGIN; ... ROLLBACK;`.

### Habits interviewers look for
- Parameters, never string concatenation (SQL injection, plus plan caching).
- Batching (`INSERT ... VALUES (...), (...)`, JDBC batches) instead of a query per row.
- Explicit column lists, explicit `ORDER BY` whenever order matters (no ORDER BY = no guaranteed order).
- Constraints in the database (`NOT NULL`, `UNIQUE`, `FOREIGN KEY`, `CHECK`), not only validation in code.

Read more: [Use The Index, Luke: paging through results](https://use-the-index-luke.com/no-offset) · [PostgreSQL: INSERT ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html) · [PostgreSQL: MERGE](https://www.postgresql.org/docs/current/sql-merge.html) · [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [PostgreSQL wiki: Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)

## Sources
- [PostgreSQL documentation](https://www.postgresql.org/docs/current/): especially the tutorial chapters on queries and window functions.
- [Modern SQL by Markus Winand](https://modern-sql.com/): what the standard allows and which databases support it.
- [Use The Index, Luke](https://use-the-index-luke.com/): SQL performance for developers, free online.
- [pgexercises.com](https://pgexercises.com/): interactive SQL practice on PostgreSQL.
