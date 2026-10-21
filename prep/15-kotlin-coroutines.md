# Kotlin & coroutines

## Kotlin essentials for Java devs
- **Null safety**: `String` vs `String?`; `?.` (safe call), `?:` (Elvis default), `!!` (throws NPE), smart casts after checks. Java types are **platform types** (`String!`): unchecked until assigned to a declared Kotlin type.
- `val` (read-only) vs `var`; type inference; string templates `"Hello, $name"`; `==` is `equals`, `===` is reference equality.
- Classes and methods are **final by default** (`open` to allow overriding). For Spring proxies use the `kotlin-spring` (all-open) plugin; for JPA entities `kotlin-jpa` (no-arg constructors).
- `data class`: `equals`/`hashCode`/`toString`/`copy`/`componentN` from the primary constructor's properties. Not for JPA entities.
- `object` (singleton), `companion object` (static-like members; `@JvmStatic` for Java callers), `sealed` classes/interfaces with exhaustive `when`.
- **Extension functions**: resolved statically by the declared type; no access to private members.
- Scope functions: `let` (`it`, returns the lambda result), `run`, `with`, `apply` (`this`, returns the receiver: object setup), `also` (`it`, returns the receiver: side effects).
- Default and named arguments (`@JvmOverloads` for Java); no checked exceptions (`@Throws` for Java interop).
- `List` is a **read-only interface**, not immutable; `MutableList` adds mutation. `Sequence` is lazy like a Java stream.
- `inline` functions copy the lambda into the call site: no allocation, non-local `return`, and `reified` type parameters.
- `lateinit var` (non-null, set later; access before → `UninitializedPropertyAccessException`); `by lazy { }` (computed once, synchronized by default).

## Coroutines basics
- A `suspend fun` can pause without blocking its thread. The compiler turns it into a **state machine** with an extra `Continuation` parameter (continuation-passing style).
- Builders: `launch` (returns a `Job`, no result), `async` (returns `Deferred<T>`, get it with `await()`), `runBlocking` (blocks the current thread: only for `main` and tests), `coroutineScope`, `withContext`.
- Coroutines are cheap: 100,000 of them in a few MB of heap.
- `delay()` suspends; `Thread.sleep()` blocks the thread and everything scheduled on it.

## Dispatchers
- `Dispatchers.Default`: CPU work, as many threads as cores.
- `Dispatchers.IO`: blocking I/O (JDBC, files), elastic (64 threads or more), shares threads with Default.
- `Dispatchers.Main` (UI) and `Unconfined` (rarely needed).
- `withContext(Dispatchers.IO) { jdbcCall() }` moves just that block to another dispatcher and comes back.
- Blocking calls on `Default` starve every coroutine sharing it.

## Structured concurrency
- Every coroutine runs in a `CoroutineScope`. A parent completes only when its children complete; cancelling a parent cancels its children.
- A failing child **cancels its parent and all siblings** (in `coroutineScope` / a regular `Job`). `supervisorScope` / `SupervisorJob`: children fail independently.
- Avoid `GlobalScope`: its coroutines aren't tied to any lifecycle, so they leak and their errors get lost.

## Cancellation and exceptions
- Cancellation is **cooperative**: suspension points (`delay`, `yield`, `withContext`, channel operations) check it; CPU loops must call `ensureActive()` or check `isActive`.
- `CancellationException` is the normal signal; never swallow it. `catch (e: Exception)` around suspend calls catches it too: rethrow it.
- `withTimeout(ms)` throws `TimeoutCancellationException`; `withTimeoutOrNull` returns null.
- `launch` propagates exceptions to the parent (and finally to a `CoroutineExceptionHandler`); `async` holds them until `await()`, but still fails its parent scope.
- `finally` runs on cancellation; suspending cleanup needs `withContext(NonCancellable) { ... }`.

## Flow
- `Flow` is a **cold** asynchronous stream: the `flow { emit(x) }` block runs anew for each `collect`.
- Operators: `map`, `filter`, `transform`, `flatMapMerge`, `debounce`, `catch`, `onCompletion`. `flowOn(Dispatchers.IO)` changes the context of the **upstream** part.
- Backpressure is natural: `emit` suspends until the collector is ready. `buffer()` and `conflate()` change that.
- Hot flows: `StateFlow` (always has a current value, conflated, emits only distinct values: state), `SharedFlow` (configurable replay and buffer: events).
- `Channel`: a hot queue between coroutines; `Flow` is usually the better API.

## Coroutines vs threads vs virtual threads
- Coroutines: a library + compiler feature with explicit `suspend` (function "coloring"), structured concurrency built in, works on any JVM version and Android.
- Virtual threads (Java 21): a JVM feature; existing blocking code becomes cheap without changes, but no structured concurrency yet (preview API).
- Don't hold a monitor across suspension (suspending inside `synchronized` is a compile error); use `Mutex.withLock { }` from kotlinx.coroutines.
- Spring: `suspend` controller methods (WebFlux and MVC), coroutine repositories, `Flow` return types, `@Transactional` on suspend functions with a reactive transaction manager.
