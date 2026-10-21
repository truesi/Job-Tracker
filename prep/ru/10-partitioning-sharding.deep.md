# Партиционирование, репликация и шардирование: подробно

Здесь разделы краткого конспекта разобраны глубже. Главы 5 (репликация) и 6 (партиционирование) книги Клеппмана *Designing Data-Intensive Applications* это классический источник; инженерные блоги по ссылкам ниже показывают, как это делали реальные компании.

## Партиционирование

### Декларативное партиционирование в PostgreSQL
```sql
CREATE TABLE payments (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    created_at  timestamptz NOT NULL,
    customer_id bigint NOT NULL,
    amount      numeric(12, 2) NOT NULL,
    PRIMARY KEY (id, created_at)                 -- must include the partition key
) PARTITION BY RANGE (created_at);

CREATE TABLE payments_2024_06 PARTITION OF payments
    FOR VALUES FROM ('2024-06-01') TO ('2024-07-01');
CREATE TABLE payments_default PARTITION OF payments DEFAULT;   -- catches unexpected rows

CREATE INDEX ON payments (customer_id, created_at);   -- created on every partition
```
Партиции нужно создавать заранее. Используй расширение `pg_partman` или плановую задачу и настрой алерт, если в партицию по умолчанию начали попадать строки.

### Хранение по сроку без боли
```sql
ALTER TABLE payments DETACH PARTITION payments_2022_01 CONCURRENTLY;   -- PG 14+
DROP TABLE payments_2022_01;        -- or archive it to cold storage first
```

### Pruning: при планировании и при выполнении
С литералом (`WHERE created_at >= '2024-06-01'`) pruning происходит при планировании. С параметром PostgreSQL отсекает партиции при выполнении (EXPLAIN показывает `Subplans Removed: N`). Условие, которое планировщик не может связать с ключом, ничего не отсекает: `WHERE date_trunc('month', created_at) = ...` сканирует всё.

### Когда партиционирование не стоит того
До десятков миллионов строк хороший индекс обычно выигрывает. Партиционирование помогает, когда есть естественный ключ, по которому фильтрует большинство запросов, и/или реально нужно массово удалять старые данные. Hash-партиционирование по `customer_id` просто "чтобы было быстрее" часто замедляет запросы без этого ключа.

Подробнее: [PostgreSQL: table partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) · [pg_partman](https://github.com/pgpartman/pg_partman)

## Репликация

### Как работает потоковая репликация
Primary пишет WAL; реплика подключается, получает поток WAL и проигрывает его, получая побайтово идентичную копию. Мониторинг:
```sql
-- on the primary
SELECT client_addr, state, sent_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS bytes_behind, replay_lag
FROM pg_stat_replication;
```
`synchronous_commit` определяет, чего ждёт коммит: `off` (ничего), `local` (сброс своего WAL), `remote_write`, `on` (синхронная реплика сбросила), `remote_apply` (синхронная реплика применила: read-your-writes на этой реплике).

### Read-your-writes в Spring-приложении
Маршрутизирующий `DataSource` отправляет `@Transactional(readOnly = true)` на реплики, а всё остальное на primary. Чтобы не читать устаревшее после записи: отправляй следующий запрос этого пользователя на primary несколько секунд (флаг в сессии или cookie со временем последней записи) или передавай LSN коммита и жди, пока `pg_last_wal_replay_lsn()` реплики его достигнет.

### Failover это самое сложное
Обнаружить мёртвый primary, повысить самую свежую реплику, переключить клиентов и изолировать (fencing) старый primary, чтобы он не принимал записи (split brain). Используй проверенные инструменты (Patroni с etcd/Consul или управляемый сервис), а не самописный скрипт. При асинхронной репликации заранее реши, сколько потери данных допустимо (RPO) и сколько может длиться восстановление (RTO).

### Логическая репликация
```sql
-- source
CREATE PUBLICATION orders_pub FOR TABLE orders, order_items;
-- target (can be a newer PostgreSQL major version)
CREATE SUBSCRIPTION orders_sub CONNECTION 'host=... dbname=shop' PUBLICATION orders_pub;
```
Типичные применения: обновление мажорной версии почти без простоя, перенос таблиц в другую базу (первый шаг при разделении базы монолита) и подача данных в аналитику. CDC-инструменты вроде Debezium читают тот же поток logical decoding.

Подробнее: [PostgreSQL: high availability and replication](https://www.postgresql.org/docs/current/high-availability.html) · [PostgreSQL: logical replication](https://www.postgresql.org/docs/current/logical-replication.html) · [Patroni](https://github.com/patroni/patroni)

## Шардирование

### Выбор ключа шардирования: вопросы к себе
1. По чему фильтрует 90% запросов? Это кандидат (`tenant_id` в B2B SaaS, `user_id` в потребительских приложениях).
2. Высокая ли у него кардинальность и равномерна ли нагрузка? Много маленьких тенантов это нормально; один тенант с 40% трафика нет (выдели большим тенантам отдельные шарды).
3. Меняется ли он когда-нибудь? Меняющийся ключ означает перенос данных между шардами.
4. Какие запросы станут межшардовыми? Админские отчёты и аналитика обычно уезжают в отдельное хранилище (warehouse, наполняемый через CDC).

### Логические шарды
Вместо того чтобы сопоставлять ключи напрямую серверам, сопоставь их с большим фиксированным числом **логических шардов** (скажем, 4096, через `hash(key) % 4096`), а логические шарды с физическими базами через маленькую таблицу соответствия. Рост означает перенос целых логических шардов на новые серверы без перехеширования ключей. Instagram, Notion и Figma описывают варианты этого подхода.

### Консистентное хеширование подробнее
Помести каждый узел в несколько псевдослучайных точек на кольце хешей (**виртуальные узлы**). Ключ принадлежит первому узлу по часовой стрелке от его хеша. При 100+ виртуальных узлах на сервер нагрузка выравнивается, а новый сервер забирает понемногу у многих, а не много у одного соседа. Это используют Cassandra, DynamoDB и многие кэши (клиенты Memcached, ring hash в Envoy).

### Snowflake ID
```
| 41 bits: ms since custom epoch | 10 bits: machine id | 12 bits: sequence |
```
Это 4096 ID в миллисекунду на машину на ~69 лет, сортируемые по времени, генерируемые локально. UUIDv7 даёт похожую упорядоченность по времени в 128 битах без необходимости раздавать machine id.

Подробнее: [Консистентное хеширование](https://en.wikipedia.org/wiki/Consistent_hashing) · [Статья Amazon Dynamo (2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) · [Snowflake ID](https://en.wikipedia.org/wiki/Snowflake_ID)

## Проблемы шардирования

### Истории шардирования из реальной жизни
- **Notion** разделил свой монолит на PostgreSQL на 480 логических шардов на 32 физических базах по ID workspace, с миграцией через двойную запись и backfill.
- **Figma** выбрала горизонтальное шардирование PostgreSQL со своим прокси-слоем, который разбирает запросы и маршрутизирует их по ключу шардирования.
Обе статьи стоит прочитать ради стратегий миграции: двойная запись, теневые чтения со сравнением, затем переключение.

### Паттерн миграции
1. Начать писать и в старое, и в новое место (или реплицировать через логическую репликацию / CDC).
2. Перенести исторические данные (backfill).
3. Проверить: сравнивать чтения из обоих мест (теневые чтения).
4. Переключить чтение, затем запись, за feature flag.
5. Какое-то время держать старый путь для отката, потом удалить.

### Межшардовые операции
- **Запросы**: разослать во все шарды и слить (сортировка, limit, агрегация) в прокси или в приложении. Задержку определяет самый медленный шард.
- **Транзакции**: избегать по устройству (держать каждую бизнес-транзакцию внутри одного ключа шардирования). Иначе саги.
- **Уникальные ограничения** между шардами (уникальный email) требуют отдельной глобальной таблицы-справочника или маршрутизации по этому значению.

Подробнее: [Notion: sharding Postgres](https://www.notion.com/blog/sharding-postgres-at-notion) · [Figma: horizontal sharding](https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/) · [Citus documentation](https://docs.citusdata.com/en/stable/) · [Vitess documentation](https://vitess.io/docs/)

## CAP и согласованность

### CAP точно
"Согласованность" в CAP означает **линеаризуемость** (каждое чтение видит последнюю запись, как будто копия одна), а "доступность" означает, что каждый запрос к неупавшему узлу получает ответ. Теорема ничего не говорит о задержке и о системах без разделения, поэтому для реальных обсуждений дизайна полезнее PACELC. К тому же "AP или CP" часто выбирается на уровне операции (уровень согласованности на запрос в Cassandra).

### Шпаргалка по моделям согласованности
| Модель | Гарантия | Пример |
|---|---|---|
| Linearizable | один глобальный актуальный порядок | etcd, записи в ZooKeeper, Spanner |
| Sequential | один порядок для всех, возможно устаревший | редко предлагается отдельно; чтения ZooKeeper (без sync) |
| Causal | причина раньше следствия для всех | ответ никогда не виден раньше вопроса |
| Read-your-writes | ты видишь свои записи | правка профиля видна после перезагрузки |
| Monotonic reads | ты никогда не возвращаешься в прошлое | нет мигания между репликами |
| Eventual | реплики сходятся, если записи прекратились | DNS, асинхронные реплики |

Подробнее: [Jepsen: consistency models](https://jepsen.io/consistency) · [CAP theorem](https://en.wikipedia.org/wiki/CAP_theorem) · [PACELC](https://en.wikipedia.org/wiki/PACELC_design_principle)

## Источники
- Martin Kleppmann, *Designing Data-Intensive Applications*, главы 5, 6 и 9.
- [Документация PostgreSQL: партиционирование и репликация](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [Статья Amazon Dynamo](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf): консистентное хеширование, кворумы и eventual consistency в одной статье.
- Инженерные блоги: Notion и Figma (ссылки выше) и пост Instagram "Sharding & IDs at Instagram".
