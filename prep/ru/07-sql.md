# SQL

## Порядок выполнения запроса
- Логический порядок: `FROM`/`JOIN` → `WHERE` → `GROUP BY` → `HAVING` → `SELECT` (здесь же оконные функции) → `DISTINCT` → `ORDER BY` → `LIMIT`/`OFFSET`.
- Поэтому алиас из `SELECT` нельзя использовать в `WHERE`, но можно в `ORDER BY`. И поэтому оконную функцию нельзя поставить в `WHERE`: оберни запрос в подзапрос или CTE.
- Физический план может быть совсем другим; логический порядок определяет только смысл результата.

## Joins
- `INNER`: только совпавшие строки. `LEFT`: все левые строки, NULL там, где совпадения нет. `RIGHT`, `FULL OUTER`, `CROSS` (декартово произведение), self join.
- Условие на правую таблицу в `WHERE` превращает `LEFT JOIN` во внутренний. Ставь его в `ON`.
- **Semi-join**: `EXISTS`/`IN`. **Anti-join**: `NOT EXISTS`. `NOT IN` не возвращает вообще ничего, если в подзапросе есть NULL.
- Join один-ко-многим размножает строки (**fan-out**). Агрегация после join двух дочерних таблиц считает дважды.

## NULL
- Трёхзначная логика: `NULL = NULL` даёт UNKNOWN, а не TRUE. Используй `IS NULL` и `IS [NOT] DISTINCT FROM`.
- `WHERE` оставляет только TRUE, поэтому `col <> 'x'` молча выкидывает NULL.
- `COUNT(*)` считает строки; `COUNT(col)` пропускает NULL. `SUM`/`AVG`/`MIN`/`MAX` игнорируют NULL. `SUM` по нулю строк даёт NULL, а не 0.
- `COALESCE(a, b, 0)` возвращает первое не-NULL значение. `NULLIF(a, 0)` спасает от деления на ноль.

## Группировка и агрегаты
- Каждый неагрегированный столбец в `SELECT` должен быть в `GROUP BY` (или функционально зависеть от сгруппированного первичного ключа в PostgreSQL).
- `WHERE` фильтрует строки до группировки; `HAVING` фильтрует группы после.
- Возможности PostgreSQL: `COUNT(*) FILTER (WHERE status = 'PAID')`, `string_agg`, `array_agg`, `GROUPING SETS`, `ROLLUP`, `CUBE`.

## Оконные функции
- `fn() OVER (PARTITION BY ... ORDER BY ... frame)` считает по связанным строкам, **не схлопывая их**.
- `ROW_NUMBER` (1, 2, 3), `RANK` (1, 1, 3: с пропусками), `DENSE_RANK` (1, 1, 2), `NTILE(n)`.
- `LAG`/`LEAD`: значение предыдущей или следующей строки. `FIRST_VALUE`/`LAST_VALUE`.
- Нарастающий итог: `SUM(amount) OVER (ORDER BY day)`. Скользящее среднее: frame `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW`.
- Top-N в каждой группе: `ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC)` в CTE, затем `WHERE rn <= N`.

## Подзапросы и CTE
- Скалярные, строковые, табличные подзапросы; коррелированные подзапросы ссылаются на внешнюю строку.
- `WITH` (CTE) даёт имя подзапросу. `WITH RECURSIVE` обходит иерархии (оргструктуры, деревья категорий, графы).
- PostgreSQL 12+ встраивает нерекурсивные CTE, если не написать `MATERIALIZED`.
- `UNION` убирает дубликаты (лишняя сортировка или хеширование); `UNION ALL` нет и работает быстрее. `INTERSECT`, `EXCEPT`.

## Классические задачи
- Вторая по величине зарплата, N-я по величине, top-N в каждой группе.
- Найти дубликаты (`GROUP BY ... HAVING COUNT(*) > 1`) и удалить их, оставив одну строку.
- Сотрудники, которые получают больше своего руководителя (self join).
- Клиенты без заказов (anti-join).
- Нарастающие итоги, изменение месяц к месяцу (`LAG`), gaps and islands (непрерывные серии).

## Как писать хороший SQL
- Пагинация: `OFFSET` читает и выбрасывает все пропущенные строки. **Keyset-пагинация** (`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20`) остаётся быстрой.
- Пиши **sargable** предикаты: `WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02'`, а не `WHERE DATE(created_at) = ...`.
- Избегай `SELECT *` в коде приложения: он мешает index-only scan и ломается при изменении столбцов.
- Upsert: `INSERT ... ON CONFLICT (key) DO UPDATE` (PostgreSQL), `MERGE` (стандарт SQL, PostgreSQL 15+).
- `DELETE` удаляет строки по одной (с `WHERE`, триггерами, возвращает количество); `TRUNCATE` очищает таблицу целиком (транзакционен в PostgreSQL); `DROP` удаляет таблицу.
- `EXPLAIN (ANALYZE, BUFFERS)` показывает реальный план, число строк и I/O.
