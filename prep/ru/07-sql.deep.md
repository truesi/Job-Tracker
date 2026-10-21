# SQL: подробно

Здесь разделы краткого конспекта разобраны глубже. Примеры для PostgreSQL. Таблицы во всех примерах: `emp(id, name, dept_id, manager_id, salary)`, `dept(id, name)`, `orders(id, customer_id, created_at, amount, status)`.

## Порядок выполнения запроса

### Разбор одного запроса
```sql
SELECT d.name, COUNT(*) AS cnt                -- 5. pick columns, compute aggregates
FROM emp e JOIN dept d ON d.id = e.dept_id    -- 1. build the joined rows
WHERE e.salary > 1000                         -- 2. filter rows
GROUP BY d.name                               -- 3. group
HAVING COUNT(*) > 5                           -- 4. filter groups
ORDER BY cnt DESC                             -- 6. sort (alias visible now)
LIMIT 10;                                     -- 7. cut
```
Знание этого порядка отвечает на целый класс вопросов: почему алиасы не работают в `WHERE`, почему `HAVING` может использовать агрегаты, почему оконные функции видят строки уже после `WHERE` и `GROUP BY` (поэтому `COUNT(*) OVER ()` после фильтра считает отфильтрованные строки), и почему для `DISTINCT` + `ORDER BY` столбцы сортировки должны быть в списке выборки.

Подробнее: [PostgreSQL: SELECT](https://www.postgresql.org/docs/current/sql-select.html) · [PostgreSQL: Queries chapter](https://www.postgresql.org/docs/current/queries.html)

## Joins

### ON и WHERE во внешних соединениях
```sql
-- all customers, with their paid orders if any
SELECT c.name, o.id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'PAID';
```
Условие в `ON` решает, какие строки *совпали*; несовпавшие левые строки сохраняются с NULL. Условие в `WHERE` фильтрует *результат*, уже после того, как NULL добавлены.

### Semi- и anti-join
```sql
-- customers with at least one order (no duplicates, unlike a JOIN)
SELECT * FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);

-- customers without orders
SELECT * FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```
PostgreSQL планирует `EXISTS` как semi/anti-join (hash или merge), поэтому он не медленнее join. Предпочитай его `IN (подзапрос)`, когда могут быть важны дубликаты или NULL.

### Алгоритмы соединения (что видно в EXPLAIN)
- **Nested loop**: для каждой внешней строки ищем внутренние строки. Отлично, когда внешняя сторона маленькая, а у внутренней есть индекс.
- **Hash join**: строим хеш-таблицу по меньшему входу и проверяем её большим. Хорош для больших несортированных входов с условием равенства.
- **Merge join**: оба входа отсортированы по ключу и проходятся вместе. Хорош, когда входы уже отсортированы (например, индексами).

### Fan-out, исправленный
```sql
SELECT c.id, o.order_total, p.paid_total
FROM customers c
LEFT JOIN (SELECT customer_id, SUM(amount) AS order_total FROM orders GROUP BY customer_id) o
       ON o.customer_id = c.id
LEFT JOIN (SELECT customer_id, SUM(amount) AS paid_total FROM payments GROUP BY customer_id) p
       ON p.customer_id = c.id;
```

Подробнее: [PostgreSQL: table expressions and joins](https://www.postgresql.org/docs/current/queries-table-expressions.html) · [PostgreSQL: subquery expressions](https://www.postgresql.org/docs/current/functions-subquery.html)

## NULL

### Таблицы истинности одной строкой
`TRUE AND UNKNOWN = UNKNOWN`, `FALSE AND UNKNOWN = FALSE`, `TRUE OR UNKNOWN = TRUE`, `NOT UNKNOWN = UNKNOWN`. `WHERE`, `HAVING` и `JOIN ON` оставляют строку, только если условие **TRUE**; `CHECK`-ограничения отклоняют строку, только если условие **FALSE**, поэтому NULL проходит CHECK.

### Практические последствия
```sql
WHERE status <> 'CANCELLED'                      -- drops rows where status IS NULL
WHERE status IS DISTINCT FROM 'CANCELLED'        -- keeps them
WHERE a IS NOT DISTINCT FROM b                   -- NULL-safe equality
SELECT COALESCE(SUM(amount), 0) FROM orders WHERE false;   -- 0, not NULL
SELECT total / NULLIF(count, 0)                  -- NULL instead of division by zero
```
- `UNIQUE` по умолчанию допускает много NULL (каждый NULL считается отличным). В PostgreSQL 15 добавили `UNIQUE NULLS NOT DISTINCT`.
- `ORDER BY` в PostgreSQL ставит NULL **последними** при сортировке по возрастанию (а MySQL первыми); пиши `NULLS FIRST/LAST` явно.
- `GROUP BY` и `DISTINCT` считают все NULL одной группой.

Подробнее: [PostgreSQL: comparison functions and IS DISTINCT FROM](https://www.postgresql.org/docs/current/functions-comparison.html) · [Modern SQL: NULL in SQL](https://modern-sql.com/concept/null)

## Группировка и агрегаты

### Условная агрегация
```sql
SELECT date_trunc('month', created_at) AS month,
       COUNT(*)                                   AS orders,
       COUNT(*) FILTER (WHERE status = 'PAID')    AS paid,
       SUM(amount) FILTER (WHERE status = 'PAID') AS revenue
FROM orders
GROUP BY 1
ORDER BY 1;
```
В базах без `FILTER` используй `SUM(CASE WHEN status = 'PAID' THEN amount END)`. Так строки превращаются в столбцы (pivot) за один проход.

### Промежуточные итоги
```sql
SELECT dept_id, status, SUM(amount)
FROM orders
GROUP BY ROLLUP (dept_id, status);    -- per (dept, status), per dept, and a grand total
```

Подробнее: [PostgreSQL: aggregate functions](https://www.postgresql.org/docs/current/functions-aggregate.html) · [PostgreSQL: GROUPING SETS, CUBE, ROLLUP](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-GROUPING-SETS)

## Оконные функции

### Анатомия
```sql
SELECT name, dept_id, salary,
       AVG(salary)  OVER (PARTITION BY dept_id)                        AS dept_avg,
       salary - AVG(salary) OVER (PARTITION BY dept_id)                AS diff_from_avg,
       RANK()       OVER (PARTITION BY dept_id ORDER BY salary DESC)   AS rank_in_dept,
       SUM(salary)  OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
FROM emp;
```

### Ловушка с frame
С `ORDER BY` и без явного frame по умолчанию используется `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Два следствия:
- Строки с **равными** значениями `ORDER BY` считаются peers и получают одинаковый нарастающий итог. Для итога строго по строкам используй `ROWS`.
- `LAST_VALUE(x) OVER (ORDER BY ...)` возвращает текущую строку, а не последнюю в разделе. Пиши `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.

### Именованные окна
```sql
SELECT day, revenue,
       AVG(revenue) OVER w7 AS avg_7d,
       MAX(revenue) OVER w7 AS max_7d
FROM daily_revenue
WINDOW w7 AS (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW);
```

Подробнее: [PostgreSQL tutorial: window functions](https://www.postgresql.org/docs/current/tutorial-window.html) · [PostgreSQL: window function list](https://www.postgresql.org/docs/current/functions-window.html)

## Подзапросы и CTE

### Рекурсивный CTE: все подчинённые руководителя
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
От циклов в грязных данных защищайся лимитом глубины или конструкцией `CYCLE` (PostgreSQL 14+).

### Материализация CTE
До PostgreSQL 12 каждый CTE был "барьером оптимизации": вычислялся один раз целиком, и внешние фильтры внутрь не проталкивались. С 12-й версии нерекурсивный CTE, на который ссылаются один раз, встраивается как подзапрос. `WITH x AS MATERIALIZED (...)` возвращает старое поведение, что полезно, когда на дорогой CTE ссылаются несколько раз.

### LATERAL
`JOIN LATERAL` позволяет подзапросу ссылаться на столбцы таблиц, стоящих раньше во `FROM`, как цикл for-each. Это удобный способ сделать top-N в группе с использованием индекса:
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

Подробнее: [PostgreSQL: WITH queries](https://www.postgresql.org/docs/current/queries-with.html) · [PostgreSQL: LATERAL subqueries](https://www.postgresql.org/docs/current/queries-table-expressions.html#QUERIES-LATERAL)

## Классические задачи

### N-я по величине зарплата в каждом отделе
```sql
SELECT dept_id, salary
FROM (
    SELECT dept_id, salary,
           DENSE_RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS r
    FROM emp
) t
WHERE r = 2;
```

### Удалить дубликаты, оставив наименьший id
```sql
DELETE FROM users u
USING (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY id) AS rn
    FROM users
) d
WHERE u.id = d.id AND d.rn > 1;
```

### Сотрудники, которые получают больше руководителя
```sql
SELECT e.name
FROM emp e
JOIN emp m ON m.id = e.manager_id
WHERE e.salary > m.salary;
```

### Рост месяц к месяцу
```sql
SELECT month, revenue,
       ROUND(100.0 * (revenue - LAG(revenue) OVER (ORDER BY month))
             / NULLIF(LAG(revenue) OVER (ORDER BY month), 0), 1) AS growth_pct
FROM monthly_revenue;
```

### Gaps and islands: серии входов подряд
Даты подряд минус их номер строки дают одинаковое значение внутри одной серии:
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

## Как писать хороший SQL

### Keyset-пагинация
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
С индексом по `(created_at DESC, id DESC)` каждая страница стоит одинаково. `id` в качестве уточнения делает порядок полным и стабильным. Цена: нельзя "прыгнуть на страницу 57".

### Паттерны upsert
```sql
INSERT INTO daily_stats (day, views)
VALUES (CURRENT_DATE, 1)
ON CONFLICT (day) DO UPDATE SET views = daily_stats.views + EXCLUDED.views;

INSERT INTO tags (name) VALUES ('java')
ON CONFLICT (name) DO NOTHING;
```

### Основы EXPLAIN
```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```
Смотри на узел с наибольшим фактическим временем, сравнивай **оценку и фактическое число строк** (большой разрыв означает плохую статистику или коррелированные столбцы) и проверяй `Buffers: shared read` (диск) против `hit` (кэш). `ANALYZE` выполняет запрос, поэтому изменяющие запросы оборачивай в `BEGIN; ... ROLLBACK;`.

### Привычки, которые ждут на собеседовании
- Параметры, никогда не конкатенация строк (SQL injection, плюс кэширование планов).
- Пакетная обработка (`INSERT ... VALUES (...), (...)`, JDBC batch) вместо запроса на каждую строку.
- Явный список столбцов, явный `ORDER BY` везде, где важен порядок (нет ORDER BY = порядок не гарантирован).
- Ограничения в базе (`NOT NULL`, `UNIQUE`, `FOREIGN KEY`, `CHECK`), а не только валидация в коде.

Подробнее: [Use The Index, Luke: paging through results](https://use-the-index-luke.com/no-offset) · [PostgreSQL: INSERT ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html) · [PostgreSQL: MERGE](https://www.postgresql.org/docs/current/sql-merge.html) · [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [PostgreSQL wiki: Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)

## Источники
- [Документация PostgreSQL](https://www.postgresql.org/docs/current/): особенно главы туториала про запросы и оконные функции.
- [Modern SQL от Markus Winand](https://modern-sql.com/): что разрешает стандарт и какие базы это поддерживают.
- [Use The Index, Luke](https://use-the-index-luke.com/): производительность SQL для разработчиков, бесплатно онлайн.
- [pgexercises.com](https://pgexercises.com/): интерактивная практика SQL на PostgreSQL.
