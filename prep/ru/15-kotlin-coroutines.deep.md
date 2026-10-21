# Kotlin и корутины: подробно

Здесь разделы краткого конспекта разобраны глубже. Официальная документация Kotlin хорошая и короткая; про корутины статьи Романа Елизарова на Medium (он руководил их дизайном) объясняют *почему*.

## Основы Kotlin для Java-разработчика

### Платформенные типы и откуда всё ещё берутся NPE
Kotlin не может знать, вернёт ли Java-метод null, поэтому его тип `T!`: можно обращаться как с `T` или как с `T?`. Компилятор вставляет проверку при присваивании не-null типу, поэтому NPE случается на границе, а не глубоко в Kotlin-коде. Аннотации вроде `@Nullable`/`@NonNull` (JSpecify, JetBrains, Spring) превращают платформенные типы в настоящие Kotlin-типы. Spring Framework 7 перевёл на JSpecify весь свой API.

Остальные источники NPE: `!!`, `lateinit` (как `UninitializedPropertyAccessException`), Java-код, меняющий данные, которые Kotlin считал не-null, и фреймворки, выставляющие поля через reflection (Jackson без Kotlin-модуля, JPA).

### Настройка Kotlin + Spring
```kotlin
plugins {
    kotlin("plugin.spring")   // all-open for @Component, @Transactional, @Async, @Cacheable...
    kotlin("plugin.jpa")      // no-arg constructors for @Entity, @Embeddable, @MappedSuperclass
}
// plus com.fasterxml.jackson.module:jackson-module-kotlin, so Jackson understands
// constructors, default values and nullability
```

### Идиомы, которые стоит знать
```kotlin
// sealed hierarchy + exhaustive when (no else needed; a new subclass breaks compilation)
sealed interface PaymentResult
data class Paid(val receiptId: String) : PaymentResult
data class Declined(val reason: String) : PaymentResult
data object Pending : PaymentResult

fun message(r: PaymentResult) = when (r) {
    is Paid -> "Paid: ${r.receiptId}"           // smart cast
    is Declined -> "Declined: ${r.reason}"
    Pending -> "Waiting..."
}

// reified generics thanks to inline
inline fun <reified T> ObjectMapper.read(json: String): T = readValue(json, T::class.java)

// value class: type safety without allocation (mostly)
@JvmInline value class OrderId(val value: Long)
```

### inline и нелокальный return
```kotlin
fun findAdmin(users: List<User>): User? {
    users.forEach { if (it.isAdmin) return it }   // returns from findAdmin: forEach is inline
    return null
}
```
С не-inline лямбдой `return` там был бы запрещён; понадобилась бы метка (`return@forEach`), которая пропускает только один элемент.

Подробнее: [Kotlin: null safety](https://kotlinlang.org/docs/null-safety.html) · [Kotlin: calling Java from Kotlin](https://kotlinlang.org/docs/java-interop.html) · [Kotlin: all-open plugin](https://kotlinlang.org/docs/all-open-plugin.html) · [Kotlin: inline functions](https://kotlinlang.org/docs/inline-functions.html) · [Kotlin: scope functions](https://kotlinlang.org/docs/scope-functions.html)

## Основы корутин

### Что делает компилятор
```kotlin
suspend fun loadProfile(id: Long): Profile {
    val user = userClient.get(id)          // suspension point 1
    val orders = orderClient.list(id)      // suspension point 2
    return Profile(user, orders)
}
```
превращается примерно в:
```java
Object loadProfile(long id, Continuation<Profile> cont) {
    // a state machine: label 0 -> call get(id, this) -> maybe return COROUTINE_SUSPENDED
    //                  label 1 -> store user, call list(id, this) -> maybe suspend
    //                  label 2 -> build Profile and return it
}
```
Когда вызов приостанавливается, функция возвращает специальный маркер `COROUTINE_SUSPENDED`, и поток свободен. Когда приходит результат, `cont.resumeWith(result)` снова входит в автомат по сохранённой метке, возможно, на другом потоке.

### Конкурентная декомпозиция
```kotlin
suspend fun loadProfile(id: Long): Profile = coroutineScope {
    val user = async { userClient.get(id) }
    val orders = async { orderClient.list(id) }
    Profile(user.await(), orders.await())      // both calls run concurrently
}
```
Если любой из вызовов упадёт, другой отменится, и `loadProfile` бросит исключение: никаких осиротевших запросов.

Подробнее: [Kotlin: coroutines basics](https://kotlinlang.org/docs/coroutines-basics.html) · [Kotlin: composing suspending functions](https://kotlinlang.org/docs/composing-suspending-functions.html) · [KEEP: coroutines design document](https://github.com/Kotlin/KEEP/blob/master/proposals/coroutines.md)

## Диспетчеры

### Как они устроены
- `Default` и `IO` делят один пул потоков. `Default` ограничен числом ядер; `IO` по умолчанию разрешает до 64 потоков (или больше, если ядер больше) поверх этого.
- `Dispatchers.IO.limitedParallelism(n)` создаёт представление со своим лимитом, например под пул соединений на 10.
- Переключение между `Default` и `IO` часто вообще не меняет поток благодаря общему пулу.

### Как выбирать
| Работа | Диспетчер |
|---|---|
| Тяжёлые вычисления, разбор больших JSON | `Default` |
| Блокирующий JDBC, файловый I/O, старые блокирующие клиенты | `IO` (или его ограниченное представление) |
| Неблокирующие suspend-клиенты (Ktor, WebClient + корутины, R2DBC) | переключение не нужно |
| Executor на virtual threads (Java 21) | `Executors.newVirtualThreadPerTaskExecutor().asCoroutineDispatcher()` |

Подробнее: [Kotlin: coroutine context and dispatchers](https://kotlinlang.org/docs/coroutine-context-and-dispatchers.html)

## Структурированная конкурентность

### Правила
1. У корутины всегда есть родительский `Job` (из её scope).
2. Родитель не завершается, пока не завершатся все дети.
3. Отмена родителя отменяет всех детей.
4. Падение ребёнка (кроме отмены) отменяет родителя, а тот отменяет остальных детей, если только родитель не supervisor.

Это даёт те же гарантии, что и стек вызовов: когда функция вернула управление, всё, что она запустила, закончилось, и ошибки не теряются.

### Scope в Spring-приложении
```kotlin
@Component
class NotificationSender(private val client: PushClient) : DisposableBean {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + CoroutineName("push"))

    fun sendAsync(n: Notification) {
        scope.launch {
            runCatching { client.send(n) }.onFailure { log.warn("push failed", it) }
        }
    }

    override fun destroy() = scope.cancel()       // tied to the bean's lifecycle
}
```
`SupervisorJob` не даёт одной упавшей отправке отменить scope, а сам scope отменяется при остановке. Именно этого не хватает `GlobalScope`.

Подробнее: [Kotlin docs: coroutine scope and structured concurrency](https://kotlinlang.org/docs/coroutines-basics.html#coroutine-scope-and-structured-concurrency) · Статья Романа Елизарова "Structured concurrency" (Medium, 2018) объясняет мотивацию

## Отмена и исключения

### Код, дружащий с отменой
```kotlin
suspend fun processAll(items: List<Item>) {
    for (item in items) {
        ensureActive()                 // CPU loop: check for cancellation
        process(item)
    }
}

suspend fun safeCall(): Result<Data> = try {
    Result.success(client.fetch())
} catch (e: CancellationException) {
    throw e                            // never swallow cancellation
} catch (e: IOException) {
    Result.failure(e)
}
```
`runCatching { }` тоже ловит `CancellationException`, это та же ловушка, что и `catch (e: Exception)`.

### Куда уходят исключения
| Билдер | Где всплывает исключение |
|---|---|
| `launch` (ребёнок) | уходит родителю и отменяет его (если это не supervisor) |
| `launch` (корневой или под supervisor) | `CoroutineExceptionHandler`, иначе uncaught handler потока |
| `async` (ребёнок) | сразу отменяет родителя **и** перебрасывается из `await()` |
| `async` (корневой или под supervisor) | только в `await()`; теряется, если никто не ждёт |
| `coroutineScope { }` | перебрасывается вызывающему |

### Таймауты
```kotlin
val price = withTimeoutOrNull(2.seconds) { pricingClient.quote(sku) } ?: fallbackPrice(sku)
```
`withTimeout` отменяет блок; ресурсы внутри нужно освобождать в `finally` или `use { }`.

Подробнее: [Kotlin: cancellation and timeouts](https://kotlinlang.org/docs/cancellation-and-timeouts.html) · [Kotlin: coroutine exceptions handling](https://kotlinlang.org/docs/exception-handling.html)

## Flow

### Холодный flow с операторами
```kotlin
fun prices(sku: String): Flow<Price> = flow {
    while (true) {
        emit(pricingClient.quote(sku))      // suspends until the collector is ready
        delay(1.seconds)
    }
}

prices("ABC")
    .distinctUntilChanged()
    .map { it.toDto() }
    .flowOn(Dispatchers.IO)                 // quote() and map run on IO
    .catch { e -> emit(PriceDto.unavailable()) }
    .collect { dto -> send(dto) }           // runs in the collector's context
```

### StateFlow для состояния, SharedFlow для событий
```kotlin
class CartViewModel {
    private val _state = MutableStateFlow(CartState.empty())
    val state: StateFlow<CartState> = _state.asStateFlow()            // new collectors get the current value

    private val _events = MutableSharedFlow<CartEvent>()             // replay = 0: no redelivery
    val events: SharedFlow<CartEvent> = _events.asSharedFlow()

    suspend fun add(item: Item) {
        _state.update { it.with(item) }                              // atomic read-modify-write
        _events.emit(CartEvent.ItemAdded(item.id))
    }
}
```
`stateIn`/`shareIn` превращают холодный flow в горячий, общий для нескольких коллекторов (например, одна подписка на источник для многих WebSocket-клиентов).

### Flow vs Reactor
`Flow` покрывает то, что делает `Flux`, с намного меньшим API и обычными suspend-функциями; Spring конвертирует одно в другое (`asFlow()`, `asFlux()`), а контроллеры WebFlux могут прямо возвращать `Flow<T>`.

Подробнее: [Kotlin: asynchronous Flow](https://kotlinlang.org/docs/flow.html) · [kotlinx.coroutines: StateFlow and SharedFlow](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.flow/-state-flow/)

## Корутины vs потоки vs virtual threads

### Сравнение
| | Platform threads | Virtual threads | Корутины |
|---|---|---|---|
| Стоимость единицы | ~1 МБ стека, поток ОС | несколько КБ в куче | несколько сотен байт |
| Блокирующий код | нормально | нормально (отмонтируется) | блокирует carrier-поток: используй `IO` |
| Изменения кода | никаких | никаких | `suspend` повсюду ("раскрашенные" функции) |
| Структурированная конкурентность | вручную | preview API (`StructuredTaskScope`) | встроена |
| Отмена | прерывание | прерывание | кооперативная, распространяется через scope |
| Платформы | JVM | JVM 21+ | JVM (любая версия), Android, JS, Native |

В Kotlin-приложении на Spring MVC и Java 21 одних virtual threads может хватить. Корутины окупаются при логике fan-out/fan-in, таймаутах и отмене поверх многих вызовов, стриминге через `Flow` или в Android/мультиплатформенном коде.

### Общее состояние
```kotlin
private val mutex = Mutex()
private var cache: Map<String, Rate> = emptyMap()

suspend fun rate(code: String): Rate = mutex.withLock {
    cache[code] ?: fetchRate(code).also { cache = cache + (code to it) }   // suspends inside safely
}
```
Для простых счётчиков подходят атомики (`AtomicInteger`, `MutableStateFlow.update`), и они дешевле мьютекса.

### Spring и корутины
```kotlin
@RestController
class OrderController(private val service: OrderService) {
    @GetMapping("/orders/{id}")
    suspend fun get(@PathVariable id: Long): OrderDto = service.find(id)

    @GetMapping("/orders", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun stream(): Flow<OrderDto> = service.liveOrders()
}
```
Под капотом Spring превращает suspend-функции в `Mono`, а `Flow` во `Flux`. В Spring MVC (не реактивном) suspend-обработчики тоже работают, через асинхронную обработку запросов.

Подробнее: [Kotlin: shared mutable state and concurrency](https://kotlinlang.org/docs/shared-mutable-state-and-concurrency.html) · [Spring Framework: Kotlin coroutines](https://docs.spring.io/spring-framework/reference/languages/kotlin/coroutines.html)

## Источники
- [Документация Kotlin: coroutines guide](https://kotlinlang.org/docs/coroutines-guide.html)
- [kotlinx.coroutines на GitHub](https://github.com/Kotlin/kotlinx.coroutines): исходники, документация и заметки о дизайне.
- Marcin Moskała, *Kotlin Coroutines: Deep Dive*: самая подробная книга по теме.
- Dmitry Jemerov, Svetlana Isakova и др., *Kotlin in Action*, 2-е издание.
