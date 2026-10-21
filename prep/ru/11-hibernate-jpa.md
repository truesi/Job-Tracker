# Hibernate и JPA

## Жизненный цикл сущности
- Состояния: **transient** (новая, Hibernate о ней не знает) → **managed** (в persistence context) → **detached** (контекст закрыт или очищен) / **removed** (запланирована к удалению).
- `persist`: transient → managed. `merge`: копирует состояние detached-объекта в managed-экземпляр и **возвращает этот экземпляр**; аргумент остаётся detached. `remove`, `detach`, `refresh`.
- `find` идёт в базу (или в кэш) и возвращает null, если записи нет. `getReference` возвращает ленивый **прокси** без запроса; обращение к несуществующему бросает `EntityNotFoundException`.
- **Persistence context** (один на `EntityManager`, обычно на транзакцию) это кэш первого уровня и identity map: один id даёт один и тот же Java-экземпляр.

## Dirty checking и flush
- Изменения managed-сущностей обнаруживаются автоматически при **flush** и пишутся как `UPDATE`, поэтому внутри транзакции `save()` не нужен.
- Flush происходит перед коммитом, перед запросом, результат которого могут затронуть ожидающие изменения (`FlushModeType.AUTO`), или при `flush()`.
- **Write-behind**: SQL выполняется при flush, а не при вызове сеттера. Исключение: id `IDENTITY` заставляют делать `INSERT` сразу при `persist` и отключают пакетную вставку JDBC.
- Dirty checking сравнивает каждую managed-сущность со снимком, сделанным при загрузке: тысячи загруженных сущностей делают каждый flush дорогим.

## Загрузка и N+1
- По умолчанию: `@ManyToOne`/`@OneToOne` **EAGER**, `@OneToMany`/`@ManyToMany` LAZY. Делай всё `LAZY` и загружай явно под каждый сценарий.
- **N+1**: один запрос загружает N родителей, затем обращение к ленивой ассоциации каждого родителя порождает ещё N запросов. Решения: `JOIN FETCH`, `@EntityGraph`, batch fetching (`@BatchSize`, `hibernate.default_batch_fetch_size`) или DTO-проекции.
- `LazyInitializationException`: обращение к ленивой ассоциации после закрытия сессии. Лечится загрузкой того, что нужно сценарию, а не Open Session In View или `enable_lazy_load_no_trans`.
- `JOIN FETCH` коллекции + пагинация → Hibernate пагинирует **в памяти** (предупреждение HHH90003004). Сначала пагинируй id родителей, потом загружай.
- Загрузка двух коллекций `List` ("bag") сразу → `MultipleBagFetchException`. Используй `Set` или два запроса.

## Маппинг
- Id: предпочтителен `SEQUENCE` (pooled optimizer резервирует блоки, `allocationSize` по умолчанию 50, дружит с batching); `IDENTITY` отключает пакетную вставку; избегай `TABLE`.
- Двунаправленные ассоциации: сторона с внешним ключом (`@ManyToOne` / `@JoinColumn`) это **owning side**; `mappedBy` помечает обратную сторону, изменения только которой не сохраняются. Синхронизируй обе стороны вспомогательными методами (`addItem`/`removeItem`).
- `cascade` распространяет операции на детей; `orphanRemoval = true` удаляет ребёнка, убранного из коллекции. Никогда не каскадируй `REMOVE` с `@ManyToMany` или в сторону родителя.
- `@Enumerated(EnumType.STRING)`: `ORDINAL` по умолчанию ломает данные при перестановке констант.
- `equals`/`hashCode`: сравнивай по натуральному/бизнес-ключу или по id с константным `hashCode`. Избегай Lombok `@Data`/`@EqualsAndHashCode`/`@ToString` на сущностях (ленивая загрузка, циклы).
- Наследование: `SINGLE_TABLE` (быстрее всего, nullable столбцы), `JOINED` (нормализовано, join-ы), `TABLE_PER_CLASS` (UNION для полиморфных запросов).
- `@Embeddable` для value objects (Money, Address).

## Кэширование
- **Кэш первого уровня**: persistence context, всегда включён, на `EntityManager`.
- **Кэш второго уровня**: на `SessionFactory`, общий для транзакций, включается явно (`@Cacheable` + провайдер: Ehcache/Caffeine через JCache, Infinispan). Для справочных данных, которые в основном читают, по id.
- **Кэш запросов** хранит id результатов и инвалидируется при любом изменении задействованных таблиц. Редко того стоит.

## Запросы
- JPQL/HQL работают с сущностями и полями; Criteria API для динамических запросов; native SQL при необходимости.
- Spring Data: производные запросы (`findByEmailAndStatus`), `@Query`, проекции (интерфейсы, классы/record DTO).
- Массовые запросы `UPDATE`/`DELETE` обходят persistence context: уже загруженные сущности устаревают. Используй `@Modifying(clearAutomatically = true)` или очищай контекст после.
- Пакетная вставка: `hibernate.jdbc.batch_size`, `order_inserts`, id через `SEQUENCE` и `flush()` + `clear()` каждые N сущностей.

## Блокировки
- **Оптимистичная**: поле `@Version`; обновление с устаревшей версией бросает `OptimisticLockException` при flush.
- **Пессимистичная**: `LockModeType.PESSIMISTIC_WRITE` → `SELECT ... FOR UPDATE`; `@Lock` на методе репозитория Spring Data.

## Особенности Spring Data JPA
- `save()`: если сущность новая (id null или version null для обёрточного типа), вызывает `persist`, иначе `merge`, который делает лишний `SELECT`. С присвоенными вручную id каждый save становится merge: реализуй `Persistable` или используй `@Version`.
- **Open Session In View** в Spring Boot включён по умолчанию (с предупреждением при старте): ленивая загрузка работает в контроллерах и представлениях, но соединение с БД держится весь запрос. Выставь `spring.jpa.open-in-view=false`.
- Производные `deleteBy...`/`deleteAll` загружают сущности и удаляют их по одной. Для массового удаления используй `@Modifying @Query("delete ...")`.
