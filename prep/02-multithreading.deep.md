# Multithreading & Java Memory Model: deep dive

This page goes deeper on the short notes, section by section. The two most useful references are *Java Concurrency in Practice* and Aleksey Shipilёv's JMM articles, linked below.

## Threads

### Platform threads cost
A platform thread maps 1:1 to an OS thread. It reserves a stack (default 1 MB on 64-bit Linux, set with `-Xss`), and switching between threads is done by the OS kernel. A few thousand threads is the practical limit, which is why servers use pools and why virtual threads exist.

### Reading a thread dump
Take one with `jstack <pid>` or `jcmd <pid> Thread.print`. What the states look like there:

| In the dump | State | Meaning |
|---|---|---|
| `waiting to lock <0x...>` | BLOCKED | waiting for a `synchronized` monitor |
| `in Object.wait()` | WAITING / TIMED_WAITING | waiting for `notify` |
| `parking to wait for <0x...>` | WAITING / TIMED_WAITING | waiting on a `j.u.c` lock, condition or queue |
| `Found one Java-level deadlock` | | the JVM found a monitor/lock cycle and prints it |

Three dumps a few seconds apart show which threads are actually stuck and which just happened to be there once.

### Exceptions in threads
- An uncaught exception kills only that thread; it goes to its `UncaughtExceptionHandler` (by default printed to stderr).
- In an `ExecutorService`, an exception from a task passed to `submit()` is **stored in the `Future`**. If nobody calls `get()`, it's silently lost. `execute()` sends it to the handler instead.
- Thread priorities are hints to the OS scheduler and are mostly ignored on Linux. Don't rely on them for correctness.

Read more: [Thread.State javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.State.html) · [jcmd manual](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)

## Interruption

### A worker that handles interruption correctly
```java
public void run() {
    while (!Thread.currentThread().isInterrupted()) {
        try {
            Task task = queue.take();          // blocking, interruptible
            process(task);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); // restore the flag, so the loop condition sees it
        }
    }
}
```

- `Thread.interrupted()` (static) **returns and clears** the flag; `isInterrupted()` only reads it.
- Some blocking is not interruptible: waiting to enter `synchronized`, and classic `java.io` socket reads. For sockets, close the socket from another thread; for locks, use `ReentrantLock.lockInterruptibly()`.
- Cancellation in executors is interruption: `future.cancel(true)` interrupts the running task, and `executor.shutdownNow()` interrupts all workers. A task that ignores interruption can't be cancelled.

Read more: [Thread.interrupt javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html#interrupt()) · Java Concurrency in Practice, chapter 7 "Cancellation and Shutdown"

## synchronized

### How monitors work
The lock state lives in the object header. An uncontended lock is taken with a CAS (lightweight locking); under contention it is *inflated* to a full monitor with a queue of waiting threads. Biased locking, an older optimization for single-thread locking, was disabled in JDK 15 (JEP 374) and later removed.

### synchronized vs ReentrantLock
| | `synchronized` | `ReentrantLock` |
|---|---|---|
| Release | automatic, even on exception | manual: `unlock()` in `finally` |
| Try / timeout | no | `tryLock()`, `tryLock(timeout)` |
| Interruptible wait | no | `lockInterruptibly()` |
| Fairness | no | optional `new ReentrantLock(true)` |
| Conditions | one wait set per object | many `Condition`s per lock |

Use `synchronized` by default; take `ReentrantLock` when you need one of its extras.

### What to lock on
Lock on a `private final Object lock = new Object()`. Locking on `this` lets outside code take your lock too. **Never** lock on string literals or boxed values: they are interned or cached, so unrelated code may share the same lock.

### wait/notify: a bounded buffer
```java
class BoundedBuffer<T> {
    private final Deque<T> items = new ArrayDeque<>();
    private final int capacity;

    BoundedBuffer(int capacity) { this.capacity = capacity; }

    synchronized void put(T item) throws InterruptedException {
        while (items.size() == capacity) wait();
        items.addLast(item);
        notifyAll();
    }

    synchronized T take() throws InterruptedException {
        while (items.isEmpty()) wait();
        T item = items.removeFirst();
        notifyAll();
        return item;
    }
}
```

Why `notifyAll` rather than `notify`: producers and consumers wait in the same wait set. `notify` may wake a producer when a consumer was needed; that producer goes back to waiting, and everyone can end up asleep. In real code use `ArrayBlockingQueue`, or a `ReentrantLock` with separate `notFull`/`notEmpty` conditions.

Read more: [JLS 17.1 Synchronization](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.1) · [JLS 17.2 Wait sets and notification](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.2) · [JEP 374 Deprecate and disable biased locking](https://openjdk.org/jeps/374)

## volatile

### What it compiles to
The JMM is implemented with memory barriers. On x86, a volatile read is a plain load, and a volatile write is followed by a `StoreLoad` barrier (a `lock`-prefixed instruction), which is why volatile writes cost more than reads. On ARM both need barriers. The JSR-133 cookbook lists which barrier goes where.

### What it doesn't do
- A volatile **reference** makes only the reference visible. Fields of the referenced object get no extra guarantees after later modification.
- Check-then-act is still a race:

```java
volatile boolean initialized;

void ensureInit() {
    if (!initialized) {      // two threads can both see false
        init();              // and both run init()
        initialized = true;
    }
}
```

### Atomic alternatives
- `AtomicInteger.incrementAndGet()` is a CAS loop: lock-free, correct, but it contends on one memory location.
- `LongAdder` spreads increments over cells and sums them on read. Much faster for hot counters (metrics) that are rarely read.
- `VarHandle` (Java 9) gives explicit access modes on fields and array elements: plain, opaque, acquire/release and volatile, plus CAS. It's what `j.u.c` uses internally.

Read more: [JSR-133 Cookbook for compiler writers](https://gee.cs.oswego.edu/dl/jmm/cookbook.html) · [VarHandle javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/invoke/VarHandle.html) · [LongAdder javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/LongAdder.html)

## Java Memory Model: happens-before

### Why there is a model at all
CPUs have store buffers and caches; compilers and the JIT reorder and cache values in registers. The JMM promises: **if a program has no data races, it behaves as if executed sequentially consistent** (DRF-SC). Racy programs get much weaker guarantees.

```java
// shared: int x = 0, y = 0;
// thread 1         // thread 2
x = 1;              y = 1;
int r1 = y;         int r2 = x;
// r1 == 0 && r2 == 0 is a legal outcome, and actually happens on x86 (store buffering)
```

### Piggybacking on a volatile
Happens-before is **transitive**. Everything written before a volatile write is visible to a thread that reads that volatile and sees the value:

```java
int data;                 // plain field
volatile boolean ready;

// writer thread
data = 42;
ready = true;

// reader thread
if (ready) {
    System.out.println(data);   // guaranteed to print 42
}
```

This is exactly how `j.u.c` classes give visibility: `ConcurrentHashMap.put` → `get`, `BlockingQueue.put` → `take`, `Future` completion → `get()`.

### Safe publication
An object is safely published to other threads if the reference is stored (JCiP 3.5.3):
1. in a static initializer;
2. in a `volatile` field or an `AtomicReference`;
3. in a `final` field of a properly constructed object;
4. in a field guarded by a lock, including putting it into a thread-safe collection.

**`this` escape** breaks this: registering a listener, starting a thread or publishing `this` from inside the constructor lets other threads see a half-built object, even with `final` fields.

### Double-checked locking and the holder idiom
```java
class Config {
    private static volatile Config instance;

    static Config get() {
        Config c = instance;                  // one volatile read on the fast path
        if (c == null) {
            synchronized (Config.class) {
                c = instance;
                if (c == null) instance = c = new Config();
            }
        }
        return c;
    }
}

class Lazy {
    private static class Holder {
        static final Lazy INSTANCE = new Lazy();
    }
    static Lazy get() { return Holder.INSTANCE; }   // class init is lazy and thread-safe (JLS 12.4.2)
}
```

Read more: [JLS 17.4 Memory Model](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.4) · [Shipilёv: JMM Pragmatics](https://shipilev.net/blog/2014/jmm-pragmatics/) · [Shipilёv: Close Encounters of the JMM Kind](https://shipilev.net/blog/2016/close-encounters-of-jmm-kind/) · [Shipilёv: Safe Publication and Safe Initialization](https://shipilev.net/blog/2014/safe-public-construction/) · [JSR-133 FAQ](https://www.cs.umd.edu/~pugh/java/memoryModel/jsr-133-faq.html) · ["Double-Checked Locking is Broken" declaration](https://www.cs.umd.edu/~pugh/java/memoryModel/DoubleCheckedLocking.html)

## Concurrency problems

### Deadlock: avoid it by ordering
```java
void transfer(Account from, Account to, long amount) {
    Account first = from.id() < to.id() ? from : to;     // global order by id
    Account second = first == from ? to : from;
    synchronized (first) {
        synchronized (second) {
            from.withdraw(amount);
            to.deposit(amount);
        }
    }
}
```

To detect it in production: a thread dump prints `Found one Java-level deadlock`, and `ThreadMXBean.findDeadlockedThreads()` finds cycles programmatically (for health checks).

### The two shapes of race conditions
- **Check-then-act**: `if (!map.containsKey(k)) map.put(k, v)`, lazy initialization. Fix: one atomic operation, such as `ConcurrentHashMap.computeIfAbsent` or `putIfAbsent`.
- **Read-modify-write**: `count++`, `balance = balance - x`. Fix: `AtomicLong`, `LongAdder`, or a lock around the whole sequence.

A class built from thread-safe parts isn't thread-safe automatically: two correct calls in a row are still a compound action.

### Livelock and starvation
- **Livelock**: two threads detect a conflict, both back off and retry in the same rhythm, forever. Fix: random backoff (as in network protocols).
- **Starvation**: a thread rarely gets the lock or CPU, for example with unfair locks under heavy contention. Fair locks fix it at a big throughput cost.

### ThreadLocal leaks
In an application server, a `ThreadLocal` value whose class came from a web app keeps that app's whole classloader alive after redeploy (pool threads outlive the app). Always `remove()` in `finally`.

Read more: [ThreadMXBean javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.management/java/lang/management/ThreadMXBean.html) · Java Concurrency in Practice, chapter 10 "Avoiding Liveness Hazards"

## Virtual threads (Java 21)

### How they work
A virtual thread is a continuation: when it blocks, its stack frames are moved to the heap and its carrier (a platform thread of a `ForkJoinPool` with parallelism = number of cores) picks up another virtual thread. Blocking JDK APIs (sockets, `j.u.c` locks, `sleep`, `BlockingQueue`) were rewritten to *park* the virtual thread instead of blocking the carrier.

- File I/O can't be made non-blocking on most OSes: it blocks the carrier, and the scheduler temporarily adds a carrier to compensate.
- Pinning shows up as the JFR event `jdk.VirtualThreadPinned`. In JDK 21 you can also run with `-Djdk.tracePinnedThreads=full`.
- `ThreadLocal` works, but with millions of threads it costs memory. `ScopedValue` is the intended replacement: immutable, bound for a scope, cheap to inherit. It became final in JDK 25 (JEP 506).

### Usage
```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> pages = urls.stream()
        .map(url -> executor.submit(() -> fetch(url)))
        .toList();
    for (Future<String> page : pages) {
        System.out.println(page.get());
    }
}   // ExecutorService.close() (Java 19+) waits for all tasks
```

In Spring Boot 3.2+, `spring.threads.virtual.enabled=true` runs Tomcat request handling and `@Async` on virtual threads.

**When they don't help**: CPU-bound work (still limited by cores), code that pins heavily on JDK 21–23, and a downstream bottleneck: 10,000 virtual threads still share a pool of 20 DB connections.

Read more: [JEP 444 Virtual Threads](https://openjdk.org/jeps/444) · [JEP 491 Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491) · [JEP 506 Scoped Values](https://openjdk.org/jeps/506) · [Oracle guide: Virtual Threads](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html)

## Sources
- [JLS chapter 17: Threads and Locks](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html): the formal memory model.
- [Aleksey Shipilёv's blog](https://shipilev.net/): the most accurate practical JMM explanations, by a JDK engineer.
- [Doug Lea: JSR-133 Cookbook](https://gee.cs.oswego.edu/dl/jmm/cookbook.html): barriers and reorderings, by the author of `j.u.c`.
- [Oracle Java Tutorial: Concurrency](https://docs.oracle.com/javase/tutorial/essential/concurrency/index.html): the basics, if anything above feels too fast.
- Brian Goetz et al., *Java Concurrency in Practice*: still the standard book, especially chapters 3 (sharing), 7 (cancellation) and 10 (liveness).
