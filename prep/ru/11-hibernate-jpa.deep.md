# Hibernate и JPA: подробно

Здесь разделы краткого конспекта разобраны глубже. Блог и книга Влада Михалчи (ссылки ниже) подробно покрывают почти любой вопрос по Hibernate на собеседовании. Пока тренируешься, включи логирование SQL (`logging.level.org.hibernate.SQL=debug`): видеть запросы это самый быстрый способ учиться.

## Жизненный цикл сущности

### Переходы состояний
```
new Order()            ── persist() ──>  MANAGED  ── commit/close ──>  DETACHED
                                           │  ▲                            │
                                 remove()  │  │ merge() returns a managed  │
                                           ▼  │ copy                       │
                                        REMOVED                            │
                                                  <── merge(detached) ─────┘
```

### Гарантия identity
Внутри одного persistence context `em.find(User.class, 1L) == em.find(User.class, 1L)` истинно, а JPQL-запрос, возвращающий ту же строку, отдаёт тот же экземпляр (с состоянием, уже лежащим в памяти, а не свежей строкой). Поэтому запрос после конкурентного обновления может вернуть "старые" данные: побеждает managed-экземпляр. Когда нужно состояние из базы, используй `em.refresh(entity)`.

### Подводные камни merge
- `merge` detached-объекта с устаревшим состоянием **затирает** более новые данные, если это не поймает `@Version`.
- `merge` каскадируется только по `cascade = MERGE` и копирует состояние всего графа объектов, поэтому частичное обновление DTO → сущность через merge может обнулить поля, которые не прислали. Лучше: загрузить сущность, применить разрешённые изменения и дать dirty checking их записать.

Подробнее: [Hibernate ORM user guide: persistence contexts](https://docs.hibernate.org/orm/6.6/userguide/html_single/#pc) · [Jakarta Persistence 3.1 specification](https://jakarta.ee/specifications/persistence/3.1/)

## Dirty checking и flush

### Что на самом деле происходит при flush
1. Для каждой managed-сущности текущие значения полей сравниваются со снимком при загрузке (или используется отслеживание изменений через bytecode enhancement).
2. Генерируются `INSERT`, `UPDATE` и `DELETE` в фиксированном порядке: вставки, обновления, изменения коллекций, удаления. Этот порядок объясняет некоторые нарушения ограничений, например когда в одном flush удаляешь и снова вставляешь тот же уникальный ключ.
3. Они выполняются, пакетами JDBC, если это настроено.

По умолчанию `UPDATE` выставляет **все** столбцы (одно закэшированное выражение на сущность). `@DynamicUpdate` пишет только изменённые столбцы: полезно для широких таблиц или чтобы реже ловить конфликты оптимистичной блокировки на несвязанных полях.

### Оптимизации только для чтения
```java
@Transactional(readOnly = true)          // Spring sets FlushMode.MANUAL, Hibernate skips snapshots
public List<OrderDto> recentOrders(long customerId) { ... }

@QueryHints(@QueryHint(name = HibernateHints.HINT_READ_ONLY, value = "true"))
List<Order> findByStatus(Status status);  // entities loaded read-only: no snapshot, no dirty check
```

### Пакетная запись
```properties
spring.jpa.properties.hibernate.jdbc.batch_size=50
spring.jpa.properties.hibernate.order_inserts=true
spring.jpa.properties.hibernate.order_updates=true
```
```java
for (int i = 0; i < rows.size(); i++) {
    em.persist(toEntity(rows.get(i)));
    if (i % 50 == 49) {
        em.flush();
        em.clear();       // keep the persistence context small
    }
}
```
С PostgreSQL добавь ещё `reWriteBatchedInserts=true` в JDBC URL, это превращает пакет в многострочные `INSERT`.

Подробнее: [Hibernate user guide: flushing](https://docs.hibernate.org/orm/6.6/userguide/html_single/#flushing) · [Hibernate user guide: batching](https://docs.hibernate.org/orm/6.6/userguide/html_single/#batch)

## Загрузка и N+1

### Как обнаружить N+1
- Смотри логи SQL или считай операторы в тестах: `hibernate.generate_statistics=true` или библиотека вроде datasource-proxy с проверкой числа запросов.
- В продакшене APM-инструменты показывают запрос с сотнями одинаковых `SELECT` с разными id.

### Четыре решения и когда какое
```java
// 1. JOIN FETCH: one query, for a specific use case
@Query("select o from Order o join fetch o.customer where o.status = :status")
List<Order> findWithCustomer(Status status);

// 2. Entity graph: the same, declaratively on a repository method
@EntityGraph(attributePaths = {"customer", "items"})
List<Order> findByStatus(Status status);

// 3. Batch fetching: global safety net, turns N+1 into N/size + 1
//    spring.jpa.properties.hibernate.default_batch_fetch_size=50

// 4. DTO projection: no entities, no lazy loading, only needed columns
@Query("select new com.shop.OrderRow(o.id, c.name, o.total) from Order o join o.customer c")
List<OrderRow> findRows();
```
Для экранов и API только на чтение DTO-проекция обычно лучший ответ: меньше данных, нет dirty checking, нет ленивых сюрпризов.

### Пагинация с коллекциями
```java
Page<Long> ids = repo.findIds(spec, pageable);                    // 1. page over ids (LIMIT in SQL)
List<Post> posts = repo.findWithCommentsByIdIn(ids.getContent()); // 2. fetch graph for those ids
```

### Почему EAGER это ловушка
EAGER нельзя выключить для отдельного запроса: каждый запрос, загружающий `Order`, загружает и его EAGER `Customer`, часто лишним запросом на каждую строку (JPQL игнорирует стратегию загрузки из маппинга и подгружает EAGER-ассоциации отдельно). LAZY + явная загрузка под сценарий оставляет управление в запросах.

Подробнее: [Vlad Mihalcea: N+1 query problem](https://vladmihalcea.com/n-plus-1-query-problem/) · [Vlad Mihalcea: MultipleBagFetchException](https://vladmihalcea.com/hibernate-multiplebagfetchexception/) · [Hibernate user guide: fetching](https://docs.hibernate.org/orm/6.6/userguide/html_single/#fetching)

## Маппинг

### Канонический one-to-many
```java
@Entity
class Order {
    @Id @GeneratedValue(strategy = GenerationType.SEQUENCE)
    private Long id;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    private List<OrderItem> items = new ArrayList<>();

    void addItem(OrderItem item) { items.add(item); item.setOrder(this); }
    void removeItem(OrderItem item) { items.remove(item); item.setOrder(null); }
}

@Entity
class OrderItem {
    @Id @GeneratedValue(strategy = GenerationType.SEQUENCE)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id")
    private Order order;
}
```
**Однонаправленный** `@OneToMany` без `@JoinColumn` создаёт join-таблицу и неэффективный SQL (удалить всё + вставить заново при изменении). Двунаправленный вариант выше или только сторона `@ManyToOne` плюс запрос лучше.

### equals и hashCode для сущностей
```java
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof OrderItem other)) return false;   // careful: Hibernate proxies are subclasses
    return id != null && id.equals(other.getId());
}

@Override
public int hashCode() {
    return getClass().hashCode();   // constant: stays the same before and after persist assigns an id
}
```
Они должны быть согласованы при переходе transient → managed, иначе сущность, добавленная в `HashSet` до `persist`, "теряется" в нём после. Натуральный ключ (`@NaturalId`, например ISBN или email) самый чистый вариант, если он есть.

### Выделение значений последовательности
`@SequenceGenerator(allocationSize = 50)` должен совпадать с `INCREMENT BY 50` последовательности в базе. Hibernate берёт одно значение и раздаёт 50 id из памяти (pooled optimizer). Несовпадение приводит к ошибкам дубликата ключа или к падению валидации при старте.

Подробнее: [Vlad Mihalcea: best way to map @OneToMany](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/) · [Vlad Mihalcea: equals and hashCode with JPA](https://vladmihalcea.com/the-best-way-to-implement-equals-hashcode-and-tostring-with-jpa-and-hibernate/) · [Hibernate user guide: identifier generators](https://docs.hibernate.org/orm/6.6/userguide/html_single/#identifiers-generators)

## Кэширование

### Настройка кэша второго уровня
```java
@Entity
@Cacheable
@org.hibernate.annotations.Cache(usage = CacheConcurrencyStrategy.READ_WRITE)
class Country { ... }
```
```properties
spring.jpa.properties.hibernate.cache.use_second_level_cache=true
spring.jpa.properties.hibernate.cache.region.factory_class=jcache
```
- Стратегии: `READ_ONLY` (неизменяемые данные, быстрее всего), `NONSTRICT_READ_WRITE` (редкие обновления, короткая неактуальность допустима), `READ_WRITE` (soft locks держат согласованность), `TRANSACTIONAL` (JTA).
- Кэшируются сущности по id (и коллекции, если помечены). `find()` и ленивая загрузка его используют; JPQL-запросы нет, если не включён кэш запросов.
- В кластере локальный кэш каждого узла устаревает, когда пишет другой узел. Используй кластерный провайдер (Infinispan, Hazelcast) или кэшируй только данные, которые никогда не меняются.
- Часто `@Cacheable` Spring на методе сервиса, кэширующий DTO, проще и предсказуемее кэша второго уровня.

Подробнее: [Hibernate user guide: caching](https://docs.hibernate.org/orm/6.6/userguide/html_single/#caching)

## Запросы

### Проекции в Spring Data
```java
interface OrderSummary { Long getId(); BigDecimal getTotal(); }   // interface projection
record OrderRow(Long id, String customerName, BigDecimal total) { }  // record/class projection

List<OrderSummary> findByCustomerId(long customerId);   // selects only id and total
```

### Динамические фильтры
Для экранов поиска с необязательными фильтрами используй Specifications (Criteria API), Querydsl или jOOQ для SQL-ориентированного кода. Избегай склейки JPQL из строк.

### Массовые операции
```java
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("update Order o set o.status = :status where o.createdAt < :before")
int expireOld(Status status, Instant before);
```
`flushAutomatically` сначала записывает ожидающие изменения, чтобы они не потерялись и не затёрлись; `clearAutomatically` отсоединяет ставшие устаревшими сущности.

Подробнее: [Spring Data JPA: query methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html) · [Spring Data JPA: projections](https://docs.spring.io/spring-data/jpa/reference/repositories/projections.html)

## Блокировки

```java
interface AccountRepository extends JpaRepository<Account, Long> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
    Optional<Account> findForUpdateById(Long id);    // SELECT ... FOR UPDATE
}
```
- `OPTIMISTIC_FORCE_INCREMENT`: увеличивает версию даже без изменений, например чтобы заблокировать корень агрегата, когда поменялись только его дети.
- `PESSIMISTIC_READ` в PostgreSQL превращается в `FOR SHARE`.
- Оптимистичную и пессимистичную блокировку можно сочетать: `@Version` защищает от lost update между запросами, а `FOR UPDATE` сериализует горячую критическую секцию.

Подробнее: [Hibernate user guide: locking](https://docs.hibernate.org/orm/6.6/userguide/html_single/#locking)

## Особенности Spring Data JPA

### Что на самом деле делает save()
```java
@Transactional
public <S extends T> S save(S entity) {
    if (entityInformation.isNew(entity)) {
        em.persist(entity);
        return entity;
    } else {
        return em.merge(entity);
    }
}
```
`isNew` проверяет атрибут `@Version`, если он обёрточного типа, иначе проверяет, что id равен null (или 0 для примитивов). С присвоенными id (UUID, созданные в Java) каждый `save` становится `merge`, который сначала делает `SELECT` строки. Реализация `Persistable<ID>` с флагом `isNew()` это исправляет.

### Open Session In View
С включённым OSIV `EntityManager` остаётся открытым до отрисовки ответа: JSON-сериализатор может запускать ленивую загрузку (N+1 внутри Jackson), а соединение держится, пока пишется ответ. С выключенным OSIV `LazyInitializationException` точно показывает, где сценарию нужна явная загрузка. В этом и смысл.

```properties
spring.jpa.open-in-view=false
```

### Другие подвохи
- `findById` внутри транзакции возвращает managed-экземпляр; снаружи detached.
- `getById`/`getReferenceById` возвращают прокси (без запроса): удобно для установки ассоциаций и неожиданно в остальных местах.
- `existsBy...` и `countBy...` дешевле, чем загрузка сущностей.
- `deleteByStatus(...)` сначала загружает все подходящие сущности (чтобы отработали каскады и колбэки), затем удаляет их по одной.

Подробнее: [Spring Data JPA: persisting entities](https://docs.spring.io/spring-data/jpa/reference/jpa/entity-persistence.html) · [Vlad Mihalcea: Open Session in View anti-pattern](https://vladmihalcea.com/the-open-session-in-view-anti-pattern/)

## Источники
- [Hibernate ORM 6.6 User Guide](https://docs.hibernate.org/orm/6.6/userguide/html_single/)
- [Spring Data JPA reference](https://docs.spring.io/spring-data/jpa/reference/)
- [Блог Влада Михалчи](https://vladmihalcea.com/): сотни коротких статей, каждая с логами SQL.
- Vlad Mihalcea, *High-Performance Java Persistence*: производительность JDBC, JPA и Hibernate в одной книге.
- [Блог Торбена Янссена](https://thorben-janssen.com/): практические советы по Hibernate и Spring Data.
