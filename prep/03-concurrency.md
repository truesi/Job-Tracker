# java.util.concurrent

## Executors and thread pools
- `execute(Runnable)` runs a task with no result: an exception goes to the thread's uncaught handler. `submit()` returns a `Future`: an exception is stored there and lost if nobody calls `get()`.
- `shutdown()`: accept no new tasks, finish the queued ones. `shutdownNow()`: interrupt running tasks and return the queued ones. Then `awaitTermination(...)`. Since Java 19, `close()` (try-with-resources) does shutdown + wait.
- **ThreadPoolExecutor** parameters: `corePoolSize`, `maximumPoolSize`, `keepAliveTime`, `workQueue`, `threadFactory`, `RejectedExecutionHandler`.
- A new task goes: free core thread → **queue** → extra threads up to max → rejection. With an unbounded queue, `maximumPoolSize` is never reached.
- `newFixedThreadPool`: unbounded `LinkedBlockingQueue`, so tasks pile up until OOM under overload. `newCachedThreadPool`: `SynchronousQueue` and unlimited threads.
- Rejection policies: `AbortPolicy` (default, throws `RejectedExecutionException`), `CallerRunsPolicy` (the submitting thread runs the task: natural backpressure), `DiscardPolicy`, `DiscardOldestPolicy`.
- Sizing: CPU-bound ≈ number of cores; I/O-bound ≈ cores × (1 + wait time / compute time).
- `scheduleAtFixedRate` keeps the rate (runs don't overlap; late runs start immediately); `scheduleWithFixedDelay` waits a fixed delay after each run ends. An exception in a scheduled task silently cancels all future runs.
- **ForkJoinPool**: work-stealing, for recursive divide-and-conquer (`RecursiveTask`). Its common pool runs parallel streams and `CompletableFuture.*Async` calls without an executor.

## Future and CompletableFuture
- `Future.get()` blocks; `cancel(true)` interrupts the running task.
- `CompletableFuture.supplyAsync(supplier)` runs on the common `ForkJoinPool`. For blocking I/O, always pass your own executor.
- `thenApply` = map (sync transform), `thenCompose` = flatMap (the function returns another `CompletableFuture`), `thenCombine` = merge two independent futures, `allOf`/`anyOf` = wait for many.
- Errors: `exceptionally` (recover), `handle` (result or exception, always called), `whenComplete` (side effect, keeps the result). `orTimeout`/`completeOnTimeout` since Java 9.
- Non-async `then*` callbacks run in the thread that completed the previous stage, or in the caller's thread if it's already complete. `*Async` variants go to an executor.
- `join()` throws unchecked `CompletionException`; `get()` throws checked `ExecutionException` and `InterruptedException`.
- `cancel(true)` on a `CompletableFuture` does **not** interrupt the running computation.

## Locks
- `ReentrantLock`: always `lock()` before `try` and `unlock()` in `finally`. Extras over `synchronized`: `tryLock()`, timeouts, `lockInterruptibly()`, fairness, several `Condition`s.
- `ReentrantReadWriteLock`: many readers or one writer. **No upgrade**: taking the write lock while holding the read lock deadlocks. Downgrade (write → read) is allowed.
- `StampedLock`: optimistic reads (`tryOptimisticRead()` + `validate(stamp)`), very fast for read-mostly data. Not reentrant, no conditions.
- All of these are built on `AbstractQueuedSynchronizer` (AQS): an `int` state plus a queue of parked threads.

## Atomics
- `AtomicInteger`, `AtomicLong`, `AtomicReference`: lock-free updates via **CAS** (`compareAndSet`). `incrementAndGet`, `updateAndGet`, `accumulateAndGet`; the update function may be retried, so it must have no side effects.
- **ABA problem**: a value changes A → B → A and CAS succeeds although the state changed. `AtomicStampedReference` adds a version stamp.
- `LongAdder`: striped counters, far better than `AtomicLong` under heavy write contention. `sum()` isn't an atomic snapshot.

## Synchronizers
- `CountDownLatch(n)`: threads wait until `countDown()` is called n times. One-shot.
- `CyclicBarrier(n)`: n threads wait for each other at a point, with an optional barrier action. Reusable.
- `Semaphore(n)`: n permits, limits concurrent access to a resource.
- `Phaser`: a reusable barrier with a dynamic number of parties and phases. `Exchanger`: two threads swap objects.

## Concurrent collections
- **ConcurrentHashMap**: no `null` keys or values. Reads are lock-free; writes CAS into an empty bin or lock only that bin's first node (Java 8+). Iterators are weakly consistent and never throw `ConcurrentModificationException`.
- Compound actions must use atomic methods: `putIfAbsent`, `computeIfAbsent`, `compute`, `merge`. `containsKey` + `put` is a race.
- `size()` is only an estimate during concurrent updates.
- `Collections.synchronizedMap`: one lock for everything, and iteration has to be synchronized by hand.
- `CopyOnWriteArrayList`: copies the array on every write, iterators see a snapshot. For read-mostly lists, like listeners.
- **BlockingQueue**: `ArrayBlockingQueue` (bounded, one lock), `LinkedBlockingQueue` (optionally bounded, separate put/take locks), `SynchronousQueue` (no capacity, direct handoff), `PriorityBlockingQueue`, `DelayQueue`. `put`/`take` block; `offer`/`poll` can time out.
- `ConcurrentLinkedQueue`: lock-free, non-blocking. `ConcurrentSkipListMap`: a sorted concurrent map.
