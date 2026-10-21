# Hibernate & JPA

## Entity lifecycle
- States: **transient** (new, unknown to Hibernate) → **managed** (in the persistence context) → **detached** (context closed or cleared) / **removed** (scheduled for deletion).
- `persist`: transient → managed. `merge`: copies a detached object's state onto a managed instance and **returns that instance**; the argument stays detached. `remove`, `detach`, `refresh`.
- `find` hits the database (or the cache) and returns null if missing. `getReference` returns a lazy **proxy** without a query; touching a missing one throws `EntityNotFoundException`.
- The **persistence context** (one per `EntityManager`, usually per transaction) is the first-level cache and identity map: the same id gives the same Java instance.

## Dirty checking and flush
- Changes to managed entities are detected automatically at **flush** and written as `UPDATE`s, so no `save()` is needed inside a transaction.
- Flush happens before commit, before a query whose result could be affected by pending changes (`FlushModeType.AUTO`), or on `flush()`.
- **Write-behind**: SQL runs at flush time, not when a setter is called. Exception: `IDENTITY` ids force an immediate `INSERT` on `persist`, and disable JDBC insert batching.
- Dirty checking compares each managed entity with a snapshot taken at load time: thousands of loaded entities make every flush expensive.

## Fetching and N+1
- Defaults: `@ManyToOne`/`@OneToOne` are **EAGER**, `@OneToMany`/`@ManyToMany` are LAZY. Make everything `LAZY` and fetch explicitly per use case.
- **N+1**: one query loads N parents, then accessing each parent's lazy association fires N more queries. Fixes: `JOIN FETCH`, `@EntityGraph`, batch fetching (`@BatchSize`, `hibernate.default_batch_fetch_size`), or DTO projections.
- `LazyInitializationException`: a lazy association accessed after the session closed. Fix it by fetching what the use case needs, not with Open Session In View or `enable_lazy_load_no_trans`.
- `JOIN FETCH` of a collection + pagination → Hibernate paginates **in memory** (warning HHH90003004). Paginate parent ids first, then fetch.
- Fetching two `List` ("bag") collections at once → `MultipleBagFetchException`. Use `Set`s or two queries.

## Mapping
- Ids: `SEQUENCE` (the pooled optimizer reserves blocks, default `allocationSize` 50, batching-friendly) is preferred; `IDENTITY` disables insert batching; avoid `TABLE`.
- Bidirectional associations: the side with the foreign key (`@ManyToOne` / `@JoinColumn`) is the **owning side**; `mappedBy` marks the inverse side, whose changes alone aren't persisted. Keep both sides in sync with helper methods (`addItem`/`removeItem`).
- `cascade` propagates operations to children; `orphanRemoval = true` deletes a child removed from the collection. Never cascade `REMOVE` from `@ManyToMany` or towards a parent.
- `@Enumerated(EnumType.STRING)`: the default `ORDINAL` breaks data when constants are reordered.
- `equals`/`hashCode`: compare by a natural/business key, or by id with a constant `hashCode`. Avoid Lombok `@Data`/`@EqualsAndHashCode`/`@ToString` on entities (lazy loading, cycles).
- Inheritance: `SINGLE_TABLE` (fastest, nullable columns), `JOINED` (normalized, joins), `TABLE_PER_CLASS` (UNIONs for polymorphic queries).
- `@Embeddable` for value objects (Money, Address).

## Caching
- **First-level cache**: the persistence context, always on, per `EntityManager`.
- **Second-level cache**: per `SessionFactory`, shared across transactions, opt-in (`@Cacheable` + a provider: Ehcache/Caffeine via JCache, Infinispan). For read-mostly reference data, keyed by id.
- The **query cache** caches result ids and is invalidated whenever any involved table changes. Rarely worth it.

## Queries
- JPQL/HQL work on entities and fields; Criteria API for dynamic queries; native SQL when needed.
- Spring Data: derived queries (`findByEmailAndStatus`), `@Query`, projections (interface, class/record DTOs).
- Bulk `UPDATE`/`DELETE` queries bypass the persistence context: already loaded entities become stale. Use `@Modifying(clearAutomatically = true)` or clear afterwards.
- Batch inserts: `hibernate.jdbc.batch_size`, `order_inserts`, `SEQUENCE` ids, and `flush()` + `clear()` every N entities.

## Locking
- **Optimistic**: a `@Version` field; an update with a stale version throws `OptimisticLockException` at flush.
- **Pessimistic**: `LockModeType.PESSIMISTIC_WRITE` → `SELECT ... FOR UPDATE`; Spring Data `@Lock` on a repository method.

## Spring Data JPA specifics
- `save()`: if the entity is new (id null, or version null for a primitive wrapper) it calls `persist`, otherwise `merge`, which runs an extra `SELECT`. Assigned ids make every save a merge: implement `Persistable` or use `@Version`.
- **Open Session In View** is on by default in Spring Boot (with a startup warning): lazy loading works in controllers and views, but the DB connection is held for the whole request. Set `spring.jpa.open-in-view=false`.
- Derived `deleteBy...`/`deleteAll` load entities and delete them one by one. Use `@Modifying @Query("delete ...")` for bulk deletes.
