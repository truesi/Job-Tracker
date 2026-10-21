# Kotlin & coroutines: deep dive

This page goes deeper on the short notes, section by section. The official Kotlin docs are good and short; for coroutines, Roman Elizarov's articles on Medium (he led their design) explain the *why*.

## Kotlin essentials for Java devs

### Platform types and where NPEs still come from
Kotlin can't know whether a Java method returns null, so its type is `T!`: you may treat it as `T` or `T?`. The compiler inserts a check when you assign it to a non-null type, so the NPE happens at the boundary, not deep inside Kotlin code. Annotations like `@Nullable`/`@NonNull` (JSpecify, JetBrains, Spring's) turn platform types into real Kotlin types. Spring Framework 7 adopted JSpecify across its API.

Other remaining NPE sources: `!!`, `lateinit` (as `UninitializedPropertyAccessException`), Java code mutating data Kotlin assumed non-null, and frameworks that set fields by reflection (Jackson without the Kotlin module, JPA).

### Kotlin + Spring setup
```kotlin
plugins {
    kotlin("plugin.spring")   // all-open for @Component, @Transactional, @Async, @Cacheable...
    kotlin("plugin.jpa")      // no-arg constructors for @Entity, @Embeddable, @MappedSuperclass
}
// plus com.fasterxml.jackson.module:jackson-module-kotlin, so Jackson understands
// constructors, default values and nullability
```

### Idioms worth knowing
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

### inline and non-local returns
```kotlin
fun findAdmin(users: List<User>): User? {
    users.forEach { if (it.isAdmin) return it }   // returns from findAdmin: forEach is inline
    return null
}
```
With a non-inline lambda, `return` would be illegal there; you'd need a label (`return@forEach`), which only skips one element.

Read more: [Kotlin: null safety](https://kotlinlang.org/docs/null-safety.html) · [Kotlin: calling Java from Kotlin](https://kotlinlang.org/docs/java-interop.html) · [Kotlin: all-open plugin](https://kotlinlang.org/docs/all-open-plugin.html) · [Kotlin: inline functions](https://kotlinlang.org/docs/inline-functions.html) · [Kotlin: scope functions](https://kotlinlang.org/docs/scope-functions.html)

## Coroutines basics

### What the compiler does
```kotlin
suspend fun loadProfile(id: Long): Profile {
    val user = userClient.get(id)          // suspension point 1
    val orders = orderClient.list(id)      // suspension point 2
    return Profile(user, orders)
}
```
becomes, roughly:
```java
Object loadProfile(long id, Continuation<Profile> cont) {
    // a state machine: label 0 -> call get(id, this) -> maybe return COROUTINE_SUSPENDED
    //                  label 1 -> store user, call list(id, this) -> maybe suspend
    //                  label 2 -> build Profile and return it
}
```
When a call suspends, the function returns the special marker `COROUTINE_SUSPENDED` and the thread is free. When the result arrives, `cont.resumeWith(result)` re-enters the state machine at the saved label, possibly on another thread.

### Concurrent decomposition
```kotlin
suspend fun loadProfile(id: Long): Profile = coroutineScope {
    val user = async { userClient.get(id) }
    val orders = async { orderClient.list(id) }
    Profile(user.await(), orders.await())      // both calls run concurrently
}
```
If either call fails, the other is cancelled and `loadProfile` throws: no orphaned requests.

Read more: [Kotlin: coroutines basics](https://kotlinlang.org/docs/coroutines-basics.html) · [Kotlin: composing suspending functions](https://kotlinlang.org/docs/composing-suspending-functions.html) · [KEEP: coroutines design document](https://github.com/Kotlin/KEEP/blob/master/proposals/coroutines.md)

## Dispatchers

### How they're built
- `Default` and `IO` share one thread pool. `Default` is limited to the number of cores; `IO` allows up to 64 threads by default (or more if there are more cores), on top of that.
- `Dispatchers.IO.limitedParallelism(n)` creates a view with its own limit, for example to match a connection pool of 10.
- Switching between `Default` and `IO` often doesn't change threads at all, thanks to the shared pool.

### Choosing
| Work | Dispatcher |
|---|---|
| CPU-heavy computation, JSON parsing of big payloads | `Default` |
| Blocking JDBC, file I/O, legacy blocking clients | `IO` (or a limited view of it) |
| Non-blocking suspend clients (Ktor, WebClient + coroutines, R2DBC) | no switch needed |
| Virtual-thread executor (Java 21) | `Executors.newVirtualThreadPerTaskExecutor().asCoroutineDispatcher()` |

Read more: [Kotlin: coroutine context and dispatchers](https://kotlinlang.org/docs/coroutine-context-and-dispatchers.html)

## Structured concurrency

### The rules
1. A coroutine always has a parent `Job` (from its scope).
2. A parent doesn't complete until all children complete.
3. Cancelling a parent cancels all children.
4. A child's failure (other than cancellation) cancels the parent, which cancels the other children, unless the parent is a supervisor.

That gives the same guarantees as a call stack: when a function returns, everything it started has finished, and errors aren't lost.

### Scopes in a Spring application
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
A `SupervisorJob` keeps one failed send from cancelling the scope, and the scope is cancelled on shutdown. That's what `GlobalScope` lacks.

Read more: [Kotlin docs: coroutine scope and structured concurrency](https://kotlinlang.org/docs/coroutines-basics.html#coroutine-scope-and-structured-concurrency) · Roman Elizarov's article "Structured concurrency" (Medium, 2018) explains the motivation

## Cancellation and exceptions

### Cancellation-friendly code
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
`runCatching { }` catches `CancellationException` too, the same trap as `catch (e: Exception)`.

### Where exceptions go
| Builder | Exception surfaces |
|---|---|
| `launch` (child) | propagates to the parent, cancelling it (unless a supervisor) |
| `launch` (root, or under a supervisor) | `CoroutineExceptionHandler`, else the thread's uncaught handler |
| `async` (child) | cancels the parent immediately **and** is rethrown by `await()` |
| `async` (root, or under a supervisor) | only on `await()`; lost if nobody awaits |
| `coroutineScope { }` | rethrown to the caller |

### Timeouts
```kotlin
val price = withTimeoutOrNull(2.seconds) { pricingClient.quote(sku) } ?: fallbackPrice(sku)
```
`withTimeout` cancels the block; the resources inside must be released in `finally` or `use { }`.

Read more: [Kotlin: cancellation and timeouts](https://kotlinlang.org/docs/cancellation-and-timeouts.html) · [Kotlin: coroutine exceptions handling](https://kotlinlang.org/docs/exception-handling.html)

## Flow

### Cold flow with operators
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

### StateFlow for state, SharedFlow for events
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
`stateIn`/`shareIn` turn a cold flow into a hot one shared by several collectors (for example one upstream subscription for many WebSocket clients).

### Flow vs Reactor
`Flow` covers what `Flux` does with a much smaller API and plain suspend functions; Spring converts between them (`asFlow()`, `asFlux()`), and WebFlux controllers can return `Flow<T>` directly.

Read more: [Kotlin: asynchronous Flow](https://kotlinlang.org/docs/flow.html) · [kotlinx.coroutines: StateFlow and SharedFlow](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines.flow/-state-flow/)

## Coroutines vs threads vs virtual threads

### Comparison
| | Platform threads | Virtual threads | Coroutines |
|---|---|---|---|
| Cost per unit | ~1 MB stack, OS thread | a few KB on the heap | a few hundred bytes |
| Blocking code | fine | fine (unmounts) | blocks the carrier thread: use `IO` |
| Code changes | none | none | `suspend` everywhere ("colored" functions) |
| Structured concurrency | manual | preview API (`StructuredTaskScope`) | built in |
| Cancellation | interruption | interruption | cooperative, propagated through the scope |
| Platforms | JVM | JVM 21+ | JVM (any version), Android, JS, Native |

In a Kotlin Spring MVC app on Java 21, virtual threads alone may be enough. Coroutines pay off with fan-out/fan-in logic, timeouts and cancellation across many calls, `Flow` streaming, or Android/multiplatform code.

### Shared state
```kotlin
private val mutex = Mutex()
private var cache: Map<String, Rate> = emptyMap()

suspend fun rate(code: String): Rate = mutex.withLock {
    cache[code] ?: fetchRate(code).also { cache = cache + (code to it) }   // suspends inside safely
}
```
For simple counters, atomics (`AtomicInteger`, `MutableStateFlow.update`) work and are cheaper than a mutex.

### Spring and coroutines
```kotlin
@RestController
class OrderController(private val service: OrderService) {
    @GetMapping("/orders/{id}")
    suspend fun get(@PathVariable id: Long): OrderDto = service.find(id)

    @GetMapping("/orders", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun stream(): Flow<OrderDto> = service.liveOrders()
}
```
Behind the scenes Spring adapts suspend functions to `Mono` and `Flow` to `Flux`. In Spring MVC (non-reactive) suspend handlers work too, executed via async request processing.

Read more: [Kotlin: shared mutable state and concurrency](https://kotlinlang.org/docs/shared-mutable-state-and-concurrency.html) · [Spring Framework: Kotlin coroutines](https://docs.spring.io/spring-framework/reference/languages/kotlin/coroutines.html)

## Sources
- [Kotlin documentation: coroutines guide](https://kotlinlang.org/docs/coroutines-guide.html)
- [kotlinx.coroutines on GitHub](https://github.com/Kotlin/kotlinx.coroutines): source, docs and design notes.
- Marcin Moskała, *Kotlin Coroutines: Deep Dive*: the most thorough book on the topic.
- Dmitry Jemerov, Svetlana Isakova et al., *Kotlin in Action*, 2nd edition.
