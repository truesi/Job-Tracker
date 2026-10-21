# Индексы: подробно

Здесь разделы краткого конспекта разобраны глубже. Примеры для PostgreSQL, если не сказано иное. *Use The Index, Luke* Маркуса Винанда это лучший единый источник по теме, и он бесплатен онлайн.

## Что такое индекс

### Модель стоимости одной картинкой
Запрос без индекса читает каждую страницу таблицы (последовательный I/O, дёшево на страницу). С индексом он читает несколько страниц индекса, а затем **по одной странице таблицы на каждую подходящую строку** (случайный I/O, дорого на страницу, если строки не лежат рядом физически). Выигрывает ли индекс, зависит от числа подходящих строк:

- 1 строка из 10 миллионов: индекс, на порядки быстрее.
- 30% строк: почти всегда последовательное сканирование.
- Между этими крайностями решает планировщик по статистике и физической корреляции столбца с порядком таблицы (`pg_stats.correlation`).

### Heap-таблицы и кластерные таблицы
- **PostgreSQL**: таблица это неупорядоченная куча; каждый индекс (включая первичный ключ) указывает на физическое расположение (TID). Обновление создаёт новую версию строки в новом месте, поэтому об этом должен узнать каждый индекс, если только это не HOT update.
- **InnoDB (MySQL)**: таблица хранится внутри B-tree первичного ключа. Строки физически упорядочены по PK, сканирование диапазона по PK очень быстрое, а вторичные индексы указывают на значение PK, а не на расположение.

Подробнее: [PostgreSQL: Indexes chapter](https://www.postgresql.org/docs/current/indexes.html) · [Use The Index, Luke: anatomy of an index](https://use-the-index-luke.com/sql/anatomy)

## B-tree

### Поиск и сканирование диапазона
1. Начать с корневой страницы и бинарным поиском по её ключам выбрать ребёнка.
2. Повторять до уровня листьев (3–4 перехода).
3. Для диапазона идти вбок по связанным страницам листьев, пока не выйдем за конец диапазона.
4. Для каждой записи прочитать строку из таблицы (если сканирование не index-only).

Медленным index scan делают **проход по листьям** и **чтения таблицы**; сам спуск по дереву дешёвый.

### Сортировка и LIKE
- B-tree можно читать в обе стороны, поэтому один индекс по `(created_at)` обслуживает и `ORDER BY created_at ASC`, и `DESC`. Смешанные направления по нескольким столбцам (`a ASC, b DESC`) требуют индекса, объявленного именно так.
- `LIKE 'abc%'` превращается в диапазон `>= 'abc' AND < 'abd'`, но только если collation сортирует символы побайтово. С не-C collation создавай индекс с `text_pattern_ops`.

### NULL
B-tree в PostgreSQL хранит NULL, поэтому `IS NULL` может использовать индекс. Oracle не индексирует ключи целиком из NULL: классическое различие между базами.

Подробнее: [PostgreSQL: B-tree indexes](https://www.postgresql.org/docs/current/btree.html) · [PostgreSQL: indexes and ORDER BY](https://www.postgresql.org/docs/current/indexes-ordering.html)

## Составные индексы

### Откуда правило левого префикса
Составной индекс отсортирован как телефонная книга: по фамилии, потом по имени. Найти "всех Смитов" или "Смит, Джон" это один переход. Найти "всех Джонов" значит прочитать всю книгу.

### Сначала равенство, диапазон последним
```sql
-- query
WHERE tenant_id = 7 AND status = 'OPEN' AND created_at >= now() - interval '7 days'

-- good: seek to (7, 'OPEN', <date>), then read one contiguous slice
CREATE INDEX ON tickets (tenant_id, status, created_at);

-- worse: the seek uses tenant_id and the created_at range; status is only filtered inside it
CREATE INDEX ON tickets (tenant_id, created_at, status);
```

### Индекс под паттерн ORDER BY + LIMIT
```sql
-- "latest 20 orders of a customer": the most common query shape in web apps
SELECT * FROM orders
WHERE customer_id = :id
ORDER BY created_at DESC
LIMIT 20;

CREATE INDEX ON orders (customer_id, created_at DESC);
```
План становится index scan, который останавливается после 20 записей, сколько бы заказов ни было у клиента. Именно на таких "конвейерных" top-N запросах индексы дают ускорение в 1000 раз.

### Skip scan
PostgreSQL 18 (и MySQL 8.0.13+) могут использовать `(a, b)` для `WHERE b = ?`, когда у `a` мало различных значений, делая по одному переходу на каждое значение `a`. Это оптимизация планировщика, а не повод проектировать индексы в неправильном порядке.

Подробнее: [PostgreSQL: multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html) · [Use The Index, Luke: concatenated keys](https://use-the-index-luke.com/sql/where-clause/the-equals-operator/concatenated-keys)

## Покрывающие индексы и index-only scan

### Столбцы INCLUDE
```sql
CREATE INDEX orders_customer_idx ON orders (customer_id) INCLUDE (status, amount);

-- answered from the index alone
SELECT status, amount FROM orders WHERE customer_id = 42;
```
Столбцы `INCLUDE` хранятся только в листьях и не участвуют в порядке сортировки, поэтому не влияют на уникальность и не раздувают внутренние страницы.

### Подвох с visibility map
Индексы PostgreSQL не хранят видимость транзакций. Index-only scan проверяет **visibility map**: если страница помечена all-visible, таблица пропускается; иначе строка читается для проверки. `EXPLAIN ANALYZE` показывает это как `Heap Fetches: N`. На часто обновляемой таблице index-only scan деградирует, пока не отработает `VACUUM`.

### Особенности InnoDB
- Каждый вторичный индекс неявно включает первичный ключ, поэтому `SELECT id FROM t WHERE email = ?` покрывается индексом по `email`.
- Выбор первичного ключа формирует всю таблицу: auto-increment `BIGINT` дописывает в конец; случайный UUID вставляет куда попало, вызывая расщепления страниц и страницы, которые остаются заполненными лишь частично. Если UUID нужны, бери упорядоченные по времени (UUIDv7) или храни их как `BINARY(16)`.

Подробнее: [PostgreSQL: index-only scans and covering indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html) · [MySQL: clustered and secondary indexes](https://dev.mysql.com/doc/refman/8.0/en/innodb-index-types.html)

## Другие типы индексов (PostgreSQL)

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
Частичный **уникальный** индекс это удобный приём для правил вида "одна активная подписка на пользователя": `CREATE UNIQUE INDEX ON subscriptions (user_id) WHERE active`.

GIN-индексы медленно обновляются (каждый документ даёт много записей), поэтому PostgreSQL копит изменения в "pending list". Большие массовые загрузки быстрее, если удалить индекс и создать заново.

Подробнее: [PostgreSQL: index types](https://www.postgresql.org/docs/current/indexes-types.html) · [PostgreSQL: partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html) · [PostgreSQL: expression indexes](https://www.postgresql.org/docs/current/indexes-expressional.html) · [PostgreSQL: pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html) · [PostgreSQL: BRIN](https://www.postgresql.org/docs/current/brin.html)

## Когда индексы не используются

### Sargable-переписывания
| Не sargable | Sargable |
|---|---|
| `WHERE DATE(created_at) = '2024-03-01'` | `WHERE created_at >= '2024-03-01' AND created_at < '2024-03-02'` |
| `WHERE amount * 1.2 > 100` | `WHERE amount > 100 / 1.2` |
| `WHERE substring(code, 1, 3) = 'ABC'` | `WHERE code LIKE 'ABC%'` |
| `WHERE coalesce(deleted, false) = false` | `WHERE deleted IS NOT TRUE` + частичный индекс, или сделай столбец `NOT NULL` |

### Статистика
`ANALYZE` делает выборку по каждому столбцу: число различных значений, самые частые значения с частотами, гистограмма, доля NULL и физическая корреляция. Планировщик считает столбцы **независимыми**: `city = 'Almaty' AND country = 'KZ'` оценивается как произведение двух селективностей, то есть сильно занижено. `CREATE STATISTICS ... (dependencies) ON city, country FROM addresses` это исправляет.

### Generic plans
Серверный prepared statement в PostgreSQL (pgjdbc переходит на него после 5 выполнений по умолчанию) получает custom plan на первые 5 запусков, а затем **generic plan**, если его оценка не хуже. При перекошенных данных (у одного тенанта 90% строк) generic plan может быть ужасен для некоторых значений параметров. Если запрос быстрый в psql, но медленный из приложения, это главный подозреваемый (`plan_cache_mode`).

Подробнее: [PostgreSQL: statistics used by the planner](https://www.postgresql.org/docs/current/planner-stats.html) · [PostgreSQL: CREATE STATISTICS](https://www.postgresql.org/docs/current/sql-createstatistics.html)

## Как читать EXPLAIN

```
Limit  (cost=0.43..8.95 rows=20 width=64) (actual time=0.031..0.058 rows=20 loops=1)
  ->  Index Scan using orders_customer_id_created_at_idx on orders
        (cost=0.43..4123.11 rows=9671 width=64) (actual time=0.030..0.054 rows=20 loops=1)
        Index Cond: (customer_id = 42)
        Buffers: shared hit=24
Planning Time: 0.110 ms
Execution Time: 0.079 ms
```
- `cost=startup..total` в условных единицах планировщика. `actual time` в мс **на один проход**: умножай на `loops`.
- `rows` оценка против факта: разрыв в 10 раз и больше заслуживает внимания.
- `Buffers: shared hit` = страницы из кэша, `read` = с диска/из ОС.
- Тревожные признаки: `Seq Scan` по большой таблице с миллионами `Rows Removed by Filter`; `Sort Method: external merge Disk`; `Nested Loop` с большим `loops` на внутренней стороне.

Длинные планы вставляй в визуализатор (explain.dalibo.com, explain.depesz.com).

Подробнее: [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html) · [explain.dalibo.com](https://explain.dalibo.com/)

## Обслуживание индексов

### Раздувание и перестроение
Удалённые и обновлённые строки оставляют мёртвые записи индекса, пока их не уберёт VACUUM, а расщепления страниц оставляют полупустые страницы. Сильно обновляемые индексы вырастают больше идеального размера. `REINDEX INDEX CONCURRENTLY` (PostgreSQL 12+) перестраивает без блокировки записи.

### Безопасный рецепт миграции для большой таблицы
```sql
-- in a migration that is NOT wrapped in a transaction (Flyway/Liquibase setting)
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_customer_created_idx
    ON orders (customer_id, created_at DESC);

-- check it finished validly
SELECT indexrelid::regclass, indisvalid FROM pg_index
WHERE indexrelid = 'orders_customer_created_idx'::regclass;
```
Если построение упало, индекс остаётся `INVALID` (и всё равно замедляет запись): удали его и повтори.

### Аудит
```sql
-- indexes never scanned since stats reset
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```
Ищи и дубликаты: `(a)` избыточен рядом с `(a, b)`, если только он не нужен для ограничения или не намного меньше и горячий.

Подробнее: [PostgreSQL: CREATE INDEX (building indexes concurrently)](https://www.postgresql.org/docs/current/sql-createindex.html) · [PostgreSQL: REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html) · [PostgreSQL: Heap-Only Tuples](https://www.postgresql.org/docs/current/storage-hot.html)

## Источники
- [Use The Index, Luke](https://use-the-index-luke.com/) Маркуса Винанда, также издана как книга *SQL Performance Explained*.
- [Документация PostgreSQL: Indexes](https://www.postgresql.org/docs/current/indexes.html) и [Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html).
- Alex Petrov, *Database Internals*: как B-tree и LSM-деревья работают на диске.
