# Hibernate & JPA: deep dive

This page goes deeper on the short notes, section by section. Vlad Mihalcea's blog and book, linked below, cover almost every Hibernate interview question in depth. Turn on SQL logging (`logging.level.org.hibernate.SQL=debug`) while practicing: seeing the queries is the fastest way to learn.

## Entity lifecycle

### State transitions
```
new Order()            ── persist() ──>  MANAGED  ── commit/close ──>  DETACHED
                                           │  ▲                            │
                                 remove()  │  │ merge() returns a managed  │
                                           ▼  │ copy                       │
                                        REMOVED                            │
                                                  <── merge(detached) ─────┘
```

### Identity guarantee
Within one persistence context, `em.find(User.class, 1L) == em.find(User.class, 1L)` is true, and a JPQL query returning the same row gives back the same instance (with the state already in memory, not the fresh row). That's why a query after a concurrent update can return "old" data: the managed instance wins. Use `em.refresh(entity)` when you need the database state.

### merge pitfalls
- `merge` on a detached object with a stale state **overwrites** newer data, unless `@Version` catches it.
- `merge` cascades only along `cascade = MERGE`, and copies the whole object graph state, so partial DTO-to-entity updates via merge can null out fields that weren't sent. Prefer: load the entity, apply the allowed changes, let dirty checking write them.

Read more: [Hibernate ORM user guide: persistence contexts](https://docs.hibernate.org/orm/6.6/userguide/html_single/#pc) · [Jakarta Persistence 3.1 specification](https://jakarta.ee/specifications/persistence/3.1/)

## Dirty checking and flush

### What actually happens at flush
1. For every managed entity, compare current field values with the load-time snapshot (or use bytecode enhancement's dirty tracking).
2. Generate `INSERT`s, `UPDATE`s and `DELETE`s in a fixed order: inserts, updates, collection changes, deletes. That order explains some constraint violations, for example when you delete and re-insert the same unique key in one flush.
3. Execute them, in JDBC batches if configured.

By default the `UPDATE` sets **all** columns (one cached statement per entity). `@DynamicUpdate` writes only changed columns: useful for wide tables or to reduce optimistic-lock conflicts on unrelated fields.

### Read-only optimizations
```java
@Transactional(readOnly = true)          // Spring sets FlushMode.MANUAL, Hibernate skips snapshots
public List<OrderDto> recentOrders(long customerId) { ... }

@QueryHints(@QueryHint(name = HibernateHints.HINT_READ_ONLY, value = "true"))
List<Order> findByStatus(Status status);  // entities loaded read-only: no snapshot, no dirty check
```

### Batch writes
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
With PostgreSQL also add `reWriteBatchedInserts=true` to the JDBC URL, which turns a batch into multi-row `INSERT`s.

Read more: [Hibernate user guide: flushing](https://docs.hibernate.org/orm/6.6/userguide/html_single/#flushing) · [Hibernate user guide: batching](https://docs.hibernate.org/orm/6.6/userguide/html_single/#batch)

## Fetching and N+1

### Detecting N+1
- Look at SQL logs, or count statements in tests: `hibernate.generate_statistics=true`, or a library like datasource-proxy with an assertion on the query count.
- In production, APM tools show a request with hundreds of identical `SELECT`s with different ids.

### Four fixes, when to use each
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
For read-only screens and APIs, a DTO projection is usually the best answer: less data, no dirty checking, no lazy surprises.

### Pagination with collections
```java
Page<Long> ids = repo.findIds(spec, pageable);                    // 1. page over ids (LIMIT in SQL)
List<Post> posts = repo.findWithCommentsByIdIn(ids.getContent()); // 2. fetch graph for those ids
```

### Why EAGER is a trap
EAGER can't be turned off per query: every query that loads an `Order` also loads its EAGER `Customer`, often with an extra query per row (JPQL ignores the mapping's fetch strategy and fetches EAGER associations separately). LAZY + explicit fetch per use case keeps control in the queries.

Read more: [Vlad Mihalcea: N+1 query problem](https://vladmihalcea.com/n-plus-1-query-problem/) · [Vlad Mihalcea: MultipleBagFetchException](https://vladmihalcea.com/hibernate-multiplebagfetchexception/) · [Hibernate user guide: fetching](https://docs.hibernate.org/orm/6.6/userguide/html_single/#fetching)

## Mapping

### The canonical one-to-many
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
A **unidirectional** `@OneToMany` without `@JoinColumn` creates a join table and inefficient SQL (delete all + re-insert on change). The bidirectional version above, or only the `@ManyToOne` side plus a query, is better.

### equals and hashCode for entities
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
It must be consistent across the transient → managed transition, otherwise an entity added to a `HashSet` before `persist` is "lost" in it afterwards. A natural key (`@NaturalId` such as ISBN or email) is the cleanest option when one exists.

### Sequence allocation
`@SequenceGenerator(allocationSize = 50)` must match `INCREMENT BY 50` of the database sequence. Hibernate fetches one value and hands out 50 ids from memory (pooled optimizer). A mismatch causes duplicate key errors or validation failures at startup.

Read more: [Vlad Mihalcea: best way to map @OneToMany](https://vladmihalcea.com/the-best-way-to-map-a-onetomany-association-with-jpa-and-hibernate/) · [Vlad Mihalcea: equals and hashCode with JPA](https://vladmihalcea.com/the-best-way-to-implement-equals-hashcode-and-tostring-with-jpa-and-hibernate/) · [Hibernate user guide: identifier generators](https://docs.hibernate.org/orm/6.6/userguide/html_single/#identifiers-generators)

## Caching

### Second-level cache setup
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
- Strategies: `READ_ONLY` (immutable data, fastest), `NONSTRICT_READ_WRITE` (rare updates, short staleness OK), `READ_WRITE` (soft locks keep it consistent), `TRANSACTIONAL` (JTA).
- It caches entities by id (and collections, if marked). `find()` and lazy loading use it; JPQL queries don't unless the query cache is on.
- In a cluster, each node's local cache goes stale when another node writes. Use a clustered provider (Infinispan, Hazelcast), or only cache data that never changes.
- Often a Spring `@Cacheable` on a service method caching DTOs is simpler and more predictable than the second-level cache.

Read more: [Hibernate user guide: caching](https://docs.hibernate.org/orm/6.6/userguide/html_single/#caching)

## Queries

### Projections in Spring Data
```java
interface OrderSummary { Long getId(); BigDecimal getTotal(); }   // interface projection
record OrderRow(Long id, String customerName, BigDecimal total) { }  // record/class projection

List<OrderSummary> findByCustomerId(long customerId);   // selects only id and total
```

### Dynamic filters
For search screens with optional filters, use Specifications (Criteria API), Querydsl, or jOOQ for SQL-first code. Avoid string concatenation of JPQL.

### Bulk operations
```java
@Modifying(clearAutomatically = true, flushAutomatically = true)
@Query("update Order o set o.status = :status where o.createdAt < :before")
int expireOld(Status status, Instant before);
```
`flushAutomatically` writes pending changes first, so they aren't lost or overwritten; `clearAutomatically` detaches the now-stale entities.

Read more: [Spring Data JPA: query methods](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html) · [Spring Data JPA: projections](https://docs.spring.io/spring-data/jpa/reference/repositories/projections.html)

## Locking

```java
interface AccountRepository extends JpaRepository<Account, Long> {
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "3000"))
    Optional<Account> findForUpdateById(Long id);    // SELECT ... FOR UPDATE
}
```
- `OPTIMISTIC_FORCE_INCREMENT`: bumps the version even without changes, for example to lock an aggregate root when only its children changed.
- `PESSIMISTIC_READ` maps to `FOR SHARE` on PostgreSQL.
- Optimistic and pessimistic locking can be combined: `@Version` protects against lost updates across requests, and `FOR UPDATE` serializes a hot critical section.

Read more: [Hibernate user guide: locking](https://docs.hibernate.org/orm/6.6/userguide/html_single/#locking)

## Spring Data JPA specifics

### What save() really does
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
`isNew` checks the `@Version` attribute if it's a wrapper type, otherwise whether the id is null (or 0 for primitives). With assigned ids (UUIDs created in Java), every `save` becomes `merge`, which first `SELECT`s the row. Implementing `Persistable<ID>` with an `isNew()` flag fixes that.

### Open Session In View
With OSIV on, the `EntityManager` stays open until the response is rendered: the JSON serializer can trigger lazy loads (N+1 inside Jackson), and the connection is held while the response is written. With OSIV off, `LazyInitializationException` shows you exactly where a use case needs explicit fetching. That's the point.

```properties
spring.jpa.open-in-view=false
```

### Other gotchas
- `findById` inside a transaction returns the managed instance; outside, a detached one.
- `getById`/`getReferenceById` return a proxy (no query), which is fine for setting associations and surprising elsewhere.
- `existsBy...` and `countBy...` are cheaper than loading entities.
- `deleteByStatus(...)` loads all matching entities first (so cascades and callbacks run), then deletes them one by one.

Read more: [Spring Data JPA: persisting entities](https://docs.spring.io/spring-data/jpa/reference/jpa/entity-persistence.html) · [Vlad Mihalcea: Open Session in View anti-pattern](https://vladmihalcea.com/the-open-session-in-view-anti-pattern/)

## Sources
- [Hibernate ORM 6.6 User Guide](https://docs.hibernate.org/orm/6.6/userguide/html_single/)
- [Spring Data JPA reference](https://docs.spring.io/spring-data/jpa/reference/)
- [Vlad Mihalcea's blog](https://vladmihalcea.com/): hundreds of focused articles, each with SQL logs.
- Vlad Mihalcea, *High-Performance Java Persistence*: JDBC, JPA and Hibernate performance in one book.
- [Thorben Janssen's blog](https://thorben-janssen.com/): practical Hibernate and Spring Data tips.
