# java.util.concurrent: deep dive

This page goes deeper on the short notes, section by section. Most of `j.u.c` was written by Doug Lea, and his papers linked below explain the design better than any blog.

## Executors and thread pools

### What execute() actually does
`ThreadPoolExecutor.execute` follows three steps:
1. Fewer than `corePoolSize` threads running → start a new thread with this task (even if others are idle).
2. Otherwise try to `offer` the task to the queue.
3. The queue refused (it's full) → start a non-core thread if below `maximumPoolSize`, otherwise reject.

Non-core threads die after `keepAliveTime` idle; core threads too if `allowCoreThreadTimeOut(true)`.

Tomcat's request pool deliberately inverts step 2 and 3: its `TaskQueue` refuses tasks while the pool can still grow, so Tomcat scales threads up to `maxThreads` first and queues after.

### A production-style pool
```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    8, 32,                                         // core, max
    60, TimeUnit.SECONDS,                          // keep-alive for non-core threads
    new ArrayBlockingQueue<>(1_000),               // bounded: overload becomes visible
    Thread.ofPlatform().name("orders-", 0).factory(),  // readable names in thread dumps
    new ThreadPoolExecutor.CallerRunsPolicy());    // backpressure instead of exceptions
```

Graceful shutdown:
```java
pool.shutdown();
if (!pool.awaitTermination(30, TimeUnit.SECONDS)) {
    pool.shutdownNow();                            // interrupt whatever is still running
}
```

### Sizing
From *Java Concurrency in Practice*: `threads = cores × target CPU utilization × (1 + wait time / compute time)`. A service that waits 90 ms on HTTP for every 10 ms of CPU on 8 cores wants ≈ 8 × (1 + 9) = 80 threads. Measure rather than guess: watch `getActiveCount()`, `getQueue().size()` and rejections (Micrometer exposes these as `executor.*` metrics).

### ForkJoinPool and work stealing
Each worker has its own deque. It pushes and pops its own subtasks LIFO (good cache locality), and idle workers steal from the other end, FIFO (they take the biggest, oldest chunks). The common pool has `cores - 1` threads. A blocking call inside it should go through `ForkJoinPool.managedBlock`, so the pool can add a compensating thread.

```java
class SumTask extends RecursiveTask<Long> {
    private final long[] a; private final int from, to;
    SumTask(long[] a, int from, int to) { this.a = a; this.from = from; this.to = to; }

    @Override protected Long compute() {
        if (to - from <= 10_000) {
            long s = 0;
            for (int i = from; i < to; i++) s += a[i];
            return s;
        }
        int mid = (from + to) >>> 1;
        SumTask left = new SumTask(a, from, mid);
        left.fork();                                   // push to own deque
        return new SumTask(a, mid, to).compute() + left.join();
    }
}
```

Read more: [ThreadPoolExecutor javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html) · [ForkJoinPool javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ForkJoinPool.html) · [Doug Lea: A Java Fork/Join Framework](https://gee.cs.oswego.edu/dl/papers/fj.pdf)

## Future and CompletableFuture

### Fan-out with timeouts and fallbacks
```java
CompletableFuture<User> user = CompletableFuture
    .supplyAsync(() -> userClient.get(id), ioPool);

CompletableFuture<List<Order>> orders = CompletableFuture
    .supplyAsync(() -> orderClient.list(id), ioPool)
    .orTimeout(2, TimeUnit.SECONDS)
    .exceptionally(ex -> List.of());               // degrade instead of failing the page

Profile profile = user.thenCombine(orders, Profile::new).join();
```

### Things that surprise people
- **Exceptions are wrapped.** In dependent stages the exception arrives as a `CompletionException` with the real exception as `getCause()`. Unwrap before checking types.
- **Which thread runs a callback.** `thenApply(f)` runs `f` in whichever thread completes the previous stage, or immediately in the calling thread if it's already complete. A slow `f` can end up on an HTTP client's I/O thread. Use `thenApplyAsync(f, executor)` when it matters.
- **Cancellation doesn't interrupt.** `cancel(true)` only completes the future exceptionally with `CancellationException`; the supplier keeps running.
- **`allOf` gives no values.** It returns `CompletableFuture<Void>`. Collect the results afterwards:

```java
List<CompletableFuture<Price>> futures = ids.stream()
    .map(id -> CompletableFuture.supplyAsync(() -> priceClient.get(id), ioPool))
    .toList();
List<Price> prices = CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new))
    .thenApply(v -> futures.stream().map(CompletableFuture::join).toList())
    .join();
```

- A forgotten future swallows its exception, just like `submit()`. Always end a chain with `join()`, `exceptionally`, or a `whenComplete` that logs.

Read more: [CompletableFuture javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletableFuture.html) · [CompletionStage javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletionStage.html)

## Locks

### AQS: the engine under everything
`AbstractQueuedSynchronizer` keeps one `volatile int state` and a FIFO queue of parked threads. Each synchronizer only defines what `state` means:

| Class | `state` means |
|---|---|
| `ReentrantLock` | hold count of the owner (0 = free) |
| `Semaphore` | available permits |
| `CountDownLatch` | remaining count |
| `ReentrantReadWriteLock` | read count (high 16 bits) and write count (low 16 bits) |

Acquire tries a CAS on `state`; if that fails, the thread enqueues and parks (`LockSupport.park`). Release updates `state` and unparks the next one.

### Fair vs unfair
An **unfair** lock (the default) lets a thread that just arrived grab a free lock before queued threads. That avoids waking a parked thread, so throughput is much higher. A **fair** lock hands the lock over in FIFO order: predictable, but slower.

### Conditions: one lock, several wait sets
```java
final Lock lock = new ReentrantLock();
final Condition notFull = lock.newCondition();
final Condition notEmpty = lock.newCondition();

void put(T x) throws InterruptedException {
    lock.lock();
    try {
        while (count == items.length) notFull.await();
        enqueue(x);
        notEmpty.signal();        // wake one consumer, never a producer
    } finally {
        lock.unlock();
    }
}
```
This is how `ArrayBlockingQueue` is written, and why `signal()` is safe here while plain `notify()` isn't.

### Read-write and stamped locks
```java
// downgrade: allowed
rw.writeLock().lock();
try {
    update();
    rw.readLock().lock();         // take read before releasing write
} finally {
    rw.writeLock().unlock();      // still holding read
}
```

```java
double distanceFromOrigin() {
    long stamp = sl.tryOptimisticRead();
    double cx = x, cy = y;
    if (!sl.validate(stamp)) {             // a writer got in: retry under a real lock
        stamp = sl.readLock();
        try { cx = x; cy = y; } finally { sl.unlockRead(stamp); }
    }
    return Math.hypot(cx, cy);
}
```
A read-write lock pays off only when reads are long and frequent. For short critical sections a plain lock or `StampedLock` is usually faster.

Read more: [AbstractQueuedSynchronizer javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/AbstractQueuedSynchronizer.html) · [StampedLock javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/StampedLock.html) · [Doug Lea: The java.util.concurrent Synchronizer Framework](https://gee.cs.oswego.edu/dl/papers/aqs.pdf)

## Atomics

### The CAS loop
```java
// what updateAndGet does, roughly
int prev, next;
do {
    prev = value.get();
    next = f.applyAsInt(prev);
} while (!value.compareAndSet(prev, next));
```
Under contention, threads retry and `f` runs several times. That's why the function must be pure. On x86 a CAS is one `lock cmpxchg` instruction, and `getAndIncrement` is `lock xadd`.

### An immutable state swapped atomically
```java
record Stats(long count, long total) {
    Stats add(long v) { return new Stats(count + 1, total + v); }
}
final AtomicReference<Stats> stats = new AtomicReference<>(new Stats(0, 0));

stats.updateAndGet(s -> s.add(latencyMs));   // two fields always consistent, no lock
```

### ABA, concretely
In a lock-free stack, thread 1 reads top = A (next = B) and is paused. Thread 2 pops A, pops B, pushes A back. Thread 1's `CAS(top, A, B)` succeeds and installs B, a node that's no longer in the stack. `AtomicStampedReference` compares the reference *and* an `int` stamp incremented on every change. In Java the GC makes ABA rarer than in C (a node isn't reused while referenced), but it still happens with pooled or reinserted objects.

### LongAdder and false sharing
`LongAdder` keeps a base value plus an array of `Cell`s. A thread whose CAS on the base fails moves to its own cell. Cells are annotated `@Contended`, padded so two cells don't share a CPU cache line. Otherwise every write would invalidate the neighbor's cache (false sharing) and kill the benefit.

Read more: [java.util.concurrent.atomic package](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/package-summary.html) · [AtomicStampedReference javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/AtomicStampedReference.html)

## Synchronizers

### CountDownLatch: start gate and end gate
```java
CountDownLatch start = new CountDownLatch(1);
CountDownLatch done = new CountDownLatch(workers);

for (int i = 0; i < workers; i++) {
    pool.execute(() -> {
        try {
            start.await();          // all workers begin at the same moment
            work();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            done.countDown();       // in finally: a failed worker must still count
        }
    });
}
start.countDown();
done.await(10, TimeUnit.SECONDS);
```
That's also a handy pattern in tests to provoke races.

### CyclicBarrier
```java
CyclicBarrier barrier = new CyclicBarrier(4, () -> mergePartialResults());
// each of 4 threads, per iteration:
computeMyChunk();
barrier.await();   // last arriving thread runs the action, then all continue
```
If one waiting thread is interrupted or times out, the barrier is **broken** and every other waiter gets `BrokenBarrierException`.

### Semaphore
Typical uses are limiting concurrent calls to a fragile downstream or limiting DB access from virtual threads. `tryAcquire(timeout)` lets you fail fast instead of queueing forever. A semaphore isn't owned by a thread: any thread may release, so be careful with the counts.

### Phaser
A reusable barrier whose party count can change (`register`/`arriveAndDeregister`). It's useful when the number of tasks per phase isn't known up front.

Read more: [CountDownLatch javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CountDownLatch.html) · [CyclicBarrier javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CyclicBarrier.html) · [Phaser javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/Phaser.html)

## Concurrent collections

### ConcurrentHashMap internals (Java 8+)
- A table of bins, like `HashMap`. Inserting into an **empty bin is a CAS**; otherwise the writer `synchronized`s on the bin's first node. So writers only contend when they hit the same bin.
- Reads take no lock at all: node fields are `volatile`, so a reader sees completely constructed nodes.
- A bin with ≥ 8 nodes (and a table of ≥ 64 bins) becomes a red-black tree, so lookups stay O(log n) even with bad hashes.
- **Resizing is cooperative**: threads that touch the map during a resize help move bins, and moved bins are marked with a `ForwardingNode`.
- The size is kept in `LongAdder`-style counter cells. `mappingCount()` returns a `long`.
- Java 7 used a different design: 16 `Segment`s, each a separate `ReentrantLock` over its part of the table.

### computeIfAbsent rules
The mapping function runs while the bin is locked, so keep it short and **never modify the same map inside it**. That throws `IllegalStateException: Recursive update`, or deadlocks in older versions.

```java
// per-key counters, safely
map.merge(word, 1L, Long::sum);

// per-key lazy cache
Connection c = connections.computeIfAbsent(host, this::connect);   // connect() must be quick
```

### BlockingQueue methods
| | throws | special value | blocks | times out |
|---|---|---|---|---|
| insert | `add` | `offer` → false | `put` | `offer(e, t, unit)` |
| remove | `remove` | `poll` → null | `take` | `poll(t, unit)` |
| examine | `element` | `peek` | | |

`ArrayBlockingQueue` uses one lock for both ends; `LinkedBlockingQueue` uses separate `putLock` and `takeLock`, so producers and consumers don't block each other, at the cost of allocating a node per element.

Read more: [ConcurrentHashMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ConcurrentHashMap.html) · [BlockingQueue javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/BlockingQueue.html)

## Sources
- [java.util.concurrent package summary](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html): includes the memory consistency guarantees of every class.
- [Doug Lea's papers](https://gee.cs.oswego.edu/dl/papers/): AQS and Fork/Join from the author.
- Brian Goetz et al., *Java Concurrency in Practice*: chapters 5 (building blocks), 8 (thread pools), 13 (explicit locks), 15 (atomics).
