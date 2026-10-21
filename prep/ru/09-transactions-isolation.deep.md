# Транзакции и изоляция: подробно

Здесь разделы краткого конспекта разобраны глубже. Глава 7 книги Мартина Клеппмана *Designing Data-Intensive Applications* это лучшее единое объяснение темы.

## ACID

### Во что обходится каждая буква
- **Atomicity** требует способа отменить изменения: PostgreSQL просто никогда не делает видимыми версии строк откаченных транзакций; InnoDB применяет undo log.
- **Durability** требует, чтобы WAL оказался на надёжном носителе до подтверждения коммита. PostgreSQL объединяет конкурентные коммиты в один fsync (group commit). `synchronous_commit = off` возвращает управление до сброса: сбой может потерять коммиты последних сотен миллисекунд, но никогда не портит данные.
- **Consistency** в ACID означает "инварианты приложения выполняются". База помогает только через ограничения (`NOT NULL`, `UNIQUE`, `FOREIGN KEY`, `CHECK`, exclusion-ограничения). Переноси как можно больше инвариантов в ограничения: только они работают при любой конкурентности.
- **Isolation** это место, где живут компромиссы, и про неё вся остальная страница.

Подробнее: [PostgreSQL: WAL introduction](https://www.postgresql.org/docs/current/wal-intro.html) · [PostgreSQL: asynchronous commit](https://www.postgresql.org/docs/current/wal-async-commit.html)

## Аномалии чтения

### Lost update по шагам
| Время | Транзакция A | Транзакция B |
|---|---|---|
| 1 | `SELECT balance` → 100 | |
| 2 | | `SELECT balance` → 100 |
| 3 | `UPDATE ... SET balance = 110` | |
| 4 | `COMMIT` | |
| 5 | | `UPDATE ... SET balance = 110` (ждёт A, потом выполняется) |
| 6 | | `COMMIT`: +10 от A потеряно |

### Write skew по шагам
```sql
-- both transactions, concurrently (REPEATABLE READ):
SELECT count(*) FROM doctors WHERE on_call AND shift_id = 1;   -- both see 2
UPDATE doctors SET on_call = false WHERE id = :me AND shift_id = 1;
COMMIT;                                                         -- both succeed, 0 on call
```
Ни одна транзакция не записала строку, которую записала другая, поэтому snapshot isolation конфликта не видит. Типичные реальные случаи: двойное бронирование переговорки, два пользователя забирают одно имя через check-then-insert (без уникального ограничения), превышение лимита при списании с двух счетов.

Решения, от простого к сложному: ограничение (уникальный индекс, exclusion-ограничение); заблокировать строки, на которых основано решение (`SELECT ... FOR UPDATE`); материализовать конфликт (заблокировать строку, представляющую смену или комнату); использовать `SERIALIZABLE`.

Подробнее: [A Critique of ANSI SQL Isolation Levels (Berenson et al., 1995)](https://www.microsoft.com/en-us/research/publication/a-critique-of-ansi-sql-isolation-levels/) · [PostgreSQL wiki: SSI and write skew examples](https://wiki.postgresql.org/wiki/SSI)

## Уровни изоляции

### Что на самом деле допускает PostgreSQL
| Уровень | Dirty read | Non-repeatable read | Phantom | Lost update | Write skew |
|---|---|---|---|---|---|
| Read committed | нет | возможно | возможно | возможно | возможно |
| Repeatable read (snapshot) | нет | нет | нет | нет (ошибка) | возможно |
| Serializable (SSI) | нет | нет | нет | нет (ошибка) | нет (ошибка) |

### Как работает SSI
Serializable Snapshot Isolation выполняет транзакции на снимках (без дополнительных блокировок), но отслеживает, какие данные каждая транзакция **прочитала** (предикатные "SIREAD" блокировки), и ищет опасный паттерн read-write зависимостей между конкурентными транзакциями. Найдя его, откатывает транзакцию с `40001`. Цена: больше откатов при конкуренции и немного памяти на отслеживание. Помогает объявлять читающие транзакции как `READ ONLY`.

### MySQL устроен иначе
REPEATABLE READ в InnoDB даёт снимок для обычных `SELECT`, но `UPDATE`, `DELETE` и `SELECT ... FOR UPDATE` читают **последнюю закоммиченную** версию и блокируют её, с gap-блокировками против фантомов. Поэтому в одной транзакции `SELECT` может показать строку, которую затем не найдёт `UPDATE`, или наоборот. Gap-блокировки к тому же частый источник deadlock в MySQL при конкурентных вставках.

### Как правильно повторять
```java
@Retryable(retryFor = ConcurrencyFailureException.class, maxAttempts = 3, backoff = @Backoff(delay = 50))
@Transactional(isolation = Isolation.SERIALIZABLE)
public void transfer(long from, long to, BigDecimal amount) { ... }
```
Повтор должен оборачивать **всю** транзакцию снаружи (advice Spring Retry по порядку выполняется раньше транзакционного). Как Spring переводит `40001`, зависит от драйвера и версии: это будет `CannotAcquireLockException` или просто `ConcurrencyFailureException`. Первое наследует второе, поэтому повторяй по `ConcurrencyFailureException`.

Подробнее: [PostgreSQL: transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) · [MySQL: InnoDB isolation levels](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html)

## MVCC

### Версии строк в PostgreSQL
Каждая версия строки (tuple) несёт `xmin` (транзакция, которая её создала) и `xmax` (транзакция, которая её удалила или заменила). `UPDATE` это удаление + вставка: старый tuple получает `xmax`, записывается новый tuple. Снимок = "транзакции, закоммиченные до меня"; tuple виден, если его `xmin` закоммичен в моём снимке, а `xmax` нет.

```sql
SELECT xmin, xmax, * FROM accounts WHERE id = 1;   -- you can actually look
```

### Зачем нужен VACUUM
Старые tuple остаются, пока их может видеть хоть один снимок. `VACUUM` (обычно autovacuum) помечает их место как переиспользуемое и обновляет visibility map. Его держит **самый старый работающий снимок** во всей базе: одна забытая транзакция, долгий отчёт или застрявший replication slot заставляют расти все таблицы. Смотри в `pg_stat_activity` на старые `xact_start` и `state = 'idle in transaction'`.

### Wraparound идентификаторов транзакций
Идентификаторы транзакций 32-битные. VACUUM "замораживает" старые tuple, чтобы их идентификаторы можно было переиспользовать. Если заморозка не успевает (VACUUM заблокирован очень долго), PostgreSQL в итоге отказывается принимать новые записи, защищая данные. Редко, но известная причина аварий.

Подробнее: [PostgreSQL: MVCC introduction](https://www.postgresql.org/docs/current/mvcc-intro.html) · [PostgreSQL: routine vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)

## Блокировки

### Режимы блокировки строк в PostgreSQL
| Конструкция | Блокирует | Типичное применение |
|---|---|---|
| `FOR UPDATE` | другие FOR UPDATE/SHARE, UPDATE, DELETE | прочитать, затем изменить |
| `FOR NO KEY UPDATE` | то же, кроме FOR KEY SHARE | то, что берёт обычный UPDATE |
| `FOR SHARE` | обновления и удаления | "эта строка не должна меняться, пока я работаю" |
| `FOR KEY SHARE` | удаление строки или изменение её ключа | берут проверки внешних ключей |

### Очередь задач на PostgreSQL
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

### Миграции и очередь блокировок
`ALTER TABLE orders ADD COLUMN ...` на мгновение нужна блокировка `ACCESS EXCLUSIVE`. Если долгий `SELECT` держит более слабую блокировку, `ALTER` ждёт, и **каждый новый запрос к таблице встаёт в очередь за `ALTER`**: таблица выглядит упавшей. Всегда:
```sql
SET lock_timeout = '3s';     -- fail fast and retry the migration instead of freezing traffic
ALTER TABLE orders ADD COLUMN note text;
```

### Advisory locks
```sql
SELECT pg_try_advisory_xact_lock(hashtext('nightly-report'));   -- true for one instance only
```
Удобно для "эту плановую задачу выполняет только один экземпляр" без дополнительной инфраструктуры. ShedLock делает то же через таблицу.

Подробнее: [PostgreSQL: explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) · [PostgreSQL: SELECT ... FOR UPDATE / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

## Оптимистичная и пессимистичная блокировка

### Как выбирать
| | Пессимистичная | Оптимистичная |
|---|---|---|
| Обработка конфликта | ждать | упасть и повторить |
| Лучше всего, когда | конфликты частые, работа короткая | конфликты редкие или пользователь редактирует минутами |
| Риски | deadlock, ждущие соединения | лавины повторов при конкуренции |
| Между HTTP-запросами | невозможна (блокировки умирают с транзакцией) | естественно: версия едет вместе с формой |

### Оптимистичная блокировка через веб-форму
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
В HTTP та же идея встроена: `ETag` + `If-Match`, ответ `412 Precondition Failed`.

## Spring @Transactional

### Как это работает
`@EnableTransactionManagement` (в Boot включён по умолчанию) оборачивает бины в прокси. Прокси запрашивает транзакцию у `PlatformTransactionManager`, привязывает соединение к текущему потоку (`TransactionSynchronizationManager`), вызывает твой метод, затем коммитит или откатывает. Всё, что использует тот же `DataSource` через Spring (JdbcTemplate, JPA-репозитории), подхватывает привязанное к потоку соединение.

Следствия:
- **Self-invocation** обходит прокси. Вызовы должны приходить из другого бина.
- **Потоки**: работа в `@Async`, `CompletableFuture.supplyAsync` или parallel stream выполняется **вне** транзакции.
- **Проглоченные исключения** внутри метода означают коммит.
- Транзакция начинается на границе метода, поэтому `@Transactional` метод контроллера держит соединение с БД весь запрос.

### Propagation наглядно
```
REQUIRED:      outer ──[ tx1 ──── inner joins tx1 ──── ]── one commit
REQUIRES_NEW:  outer ──[ tx1 ── (suspended) ── ]
                         inner ──[ tx2 ]── commits on its own connection
NESTED:        outer ──[ tx1 ── savepoint ── inner ── rollback to savepoint? ── ]
```

### События после коммита
```java
@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void onOrderPlaced(OrderPlaced event) {
    emailClient.sendConfirmation(event.orderId());   // only if the order really committed
}
```
Это самый простой способ вынести письма и HTTP-вызовы из транзакции, не отправляя их для откаченных заказов. Для гарантированной доставки используй outbox.

Подробнее: [Spring: using @Transactional](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html) · [Spring: transaction propagation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html) · [Spring: transaction-bound events](https://docs.spring.io/spring-framework/reference/data-access/transaction/event.html)

## Распределённые транзакции

### Пример саги: оформление заказа
```
Order service:    create order (PENDING) ──────────────────────────────┐
Payment service:  charge card ── ok ──> Inventory: reserve ── fails ──>│
                  refund card  <── compensation ─────────────────────── │
Order service:    mark order CANCELLED <────────────────────────────────┘
```
- **Оркестрация**: оркестратор саги заказа отправляет команды и отслеживает состояние. Проще понять и отладить.
- **Хореография**: сервисы реагируют на события друг друга. Слабее связность, но поток неявный и его труднее отследить.
- Саги жертвуют изоляцией: другие транзакции видят промежуточные состояния (заказ в PENDING, который потом отменят). Проектируй состояния так, чтобы это было безвредно ("семантические блокировки").

### Outbox на практике
```sql
BEGIN;
INSERT INTO orders (...) VALUES (...);
INSERT INTO outbox (id, aggregate_id, type, payload) VALUES (gen_random_uuid(), :orderId, 'OrderPlaced', :json);
COMMIT;
```
Relay публикует строки outbox в Kafka: либо polling (`SELECT ... FOR UPDATE SKIP LOCKED`, опубликовать, пометить отправленным), либо CDC (Debezium читает WAL: нет нагрузки от polling и проблем с порядком). В обоих случаях доставка **at least once**, поэтому потребители дедуплицируют по id события.

Подробнее: [microservices.io: Saga](https://microservices.io/patterns/data/saga.html) · [microservices.io: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) · [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

## Источники
- Martin Kleppmann, *Designing Data-Intensive Applications*, глава 7 "Transactions" и глава 9 "Consistency and Consensus".
- [PostgreSQL: Concurrency Control chapter](https://www.postgresql.org/docs/current/mvcc.html)
- [Jepsen: consistency models](https://jepsen.io/consistency): карта всех гарантий изоляции и согласованности и того, как они связаны.
- Vlad Mihalcea, *High-Performance Java Persistence*: транзакции и блокировки со стороны JDBC/JPA.
